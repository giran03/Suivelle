//! The formula language: tokenizer, parser, type checker and evaluator.
//!
//! A formula is one expression over the record's properties, written `prop("Name") * 2`. It is
//! parsed and checked when saved (so mistakes are reported with a position) and evaluated whenever
//! rows are loaded. Runtime problems never abort a load: the cell shows `#ERROR`, `#TYPE` or `#REF`.

use super::{Property, MAX_FORMULA_LEN};
use chrono::{Datelike, Duration, Months, NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const MAX_DEPTH: usize = 40;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FormulaError {
    pub message: String,
    /// Character offset of the problem in the expression.
    pub position: usize,
}

use serde::Serialize;

fn err<T>(message: impl Into<String>, position: usize) -> Result<T, FormulaError> {
    Err(FormulaError {
        message: message.into(),
        position,
    })
}

// ---------------------------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    Op(&'static str),
    LParen,
    RParen,
    Comma,
}

#[derive(Debug, Clone)]
struct Token {
    tok: Tok,
    /// Character range in the source.
    start: usize,
    end: usize,
}

fn tokenize(src: &str) -> Result<Vec<Token>, FormulaError> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let start = i;
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit()))
        {
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let text: String = chars[start..i].iter().collect();
            let Ok(n) = text.parse::<f64>() else {
                return err(format!("'{text}' is not a valid number"), start);
            };
            out.push(Token {
                tok: Tok::Num(n),
                start,
                end: i,
            });
            continue;
        }
        if c == '"' {
            i += 1;
            let mut s = String::new();
            loop {
                match chars.get(i) {
                    None => return err("this text is missing its closing quote", start),
                    Some('"') => {
                        i += 1;
                        break;
                    }
                    Some('\\') => match chars.get(i + 1) {
                        Some('n') => {
                            s.push('\n');
                            i += 2;
                        }
                        Some(&e @ ('"' | '\\')) => {
                            s.push(e);
                            i += 2;
                        }
                        _ => {
                            return err(
                                "unknown escape; use \\\" for a quote or \\\\ for a backslash",
                                i,
                            )
                        }
                    },
                    Some(&ch) => {
                        s.push(ch);
                        i += 1;
                    }
                }
            }
            out.push(Token {
                tok: Tok::Str(s),
                start,
                end: i,
            });
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            out.push(Token {
                tok: Tok::Ident(chars[start..i].iter().collect()),
                start,
                end: i,
            });
            continue;
        }
        let two: String = chars[i..(i + 2).min(chars.len())].iter().collect();
        let op2 = ["==", "!=", "<=", ">=", "&&", "||"]
            .iter()
            .find(|o| **o == two);
        if let Some(o) = op2 {
            i += 2;
            out.push(Token {
                tok: Tok::Op(o),
                start,
                end: i,
            });
            continue;
        }
        i += 1;
        let tok = match c {
            '+' => Tok::Op("+"),
            '-' => Tok::Op("-"),
            '*' => Tok::Op("*"),
            '/' => Tok::Op("/"),
            '%' => Tok::Op("%"),
            '<' => Tok::Op("<"),
            '>' => Tok::Op(">"),
            '!' => Tok::Op("!"),
            '(' => Tok::LParen,
            ')' => Tok::RParen,
            ',' => Tok::Comma,
            other => return err(format!("unexpected '{other}'"), start),
        };
        out.push(Token { tok, start, end: i });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// syntax tree and parser
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Str(String),
    Bool(bool),
    Prop(String, usize),
    Call(String, Vec<Expr>, usize),
    Not(Box<Expr>),
    Neg(Box<Expr>),
    Bin(&'static str, Box<Expr>, Box<Expr>, usize),
}

struct Parser {
    toks: Vec<Token>,
    at: usize,
    end: usize,
    depth: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.at).map(|t| &t.tok)
    }
    fn pos(&self) -> usize {
        self.toks.get(self.at).map_or(self.end, |t| t.start)
    }
    fn is_op(&self, ops: &[&str]) -> Option<&'static str> {
        match self.peek() {
            Some(Tok::Op(o)) if ops.contains(o) => Some(o),
            Some(Tok::Ident(w)) => match (w.as_str(), ops) {
                ("and", o) if o.contains(&"&&") => Some("&&"),
                ("or", o) if o.contains(&"||") => Some("||"),
                _ => None,
            },
            _ => None,
        }
    }

    fn binary(
        &mut self,
        ops: &[&str],
        next: fn(&mut Parser) -> Result<Expr, FormulaError>,
    ) -> Result<Expr, FormulaError> {
        let mut left = next(self)?;
        while let Some(op) = self.is_op(ops) {
            let pos = self.pos();
            self.at += 1;
            let right = next(self)?;
            left = Expr::Bin(op, Box::new(left), Box::new(right), pos);
        }
        Ok(left)
    }

    fn or(&mut self) -> Result<Expr, FormulaError> {
        self.binary(&["||"], Parser::and)
    }
    fn and(&mut self) -> Result<Expr, FormulaError> {
        self.binary(&["&&"], Parser::equality)
    }
    fn equality(&mut self) -> Result<Expr, FormulaError> {
        self.binary(&["==", "!="], Parser::comparison)
    }
    fn comparison(&mut self) -> Result<Expr, FormulaError> {
        self.binary(&["<", "<=", ">", ">="], Parser::additive)
    }
    fn additive(&mut self) -> Result<Expr, FormulaError> {
        self.binary(&["+", "-"], Parser::multiplicative)
    }
    fn multiplicative(&mut self) -> Result<Expr, FormulaError> {
        self.binary(&["*", "/", "%"], Parser::unary)
    }

    fn unary(&mut self) -> Result<Expr, FormulaError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return err("this formula is nested too deeply", self.pos());
        }
        let result = match self.peek() {
            Some(Tok::Op("-")) => {
                self.at += 1;
                self.unary().map(|e| Expr::Neg(Box::new(e)))
            }
            Some(Tok::Op("!")) => {
                self.at += 1;
                self.unary().map(|e| Expr::Not(Box::new(e)))
            }
            Some(Tok::Ident(w))
                if w == "not"
                    && self
                        .toks
                        .get(self.at + 1)
                        .is_some_and(|t| t.tok != Tok::LParen) =>
            {
                self.at += 1;
                self.unary().map(|e| Expr::Not(Box::new(e)))
            }
            _ => self.primary(),
        };
        self.depth -= 1;
        result
    }

    fn primary(&mut self) -> Result<Expr, FormulaError> {
        let pos = self.pos();
        let Some(token) = self.toks.get(self.at).cloned() else {
            return err("the formula ends too early", self.end);
        };
        self.at += 1;
        match token.tok {
            Tok::Num(n) => Ok(Expr::Num(n)),
            Tok::Str(s) => Ok(Expr::Str(s)),
            Tok::LParen => {
                self.depth += 1;
                if self.depth > MAX_DEPTH {
                    return err("this formula is nested too deeply", pos);
                }
                let e = self.or()?;
                self.depth -= 1;
                match self.peek() {
                    Some(Tok::RParen) => {
                        self.at += 1;
                        Ok(e)
                    }
                    _ => err("a closing parenthesis is missing", self.pos()),
                }
            }
            Tok::Ident(name) => {
                if name == "true" || name == "false" {
                    return Ok(Expr::Bool(name == "true"));
                }
                if self.peek() != Some(&Tok::LParen) {
                    return err(
                        format!(
                            "'{name}' is not a function; refer to a property as prop(\"{name}\")"
                        ),
                        pos,
                    );
                }
                self.at += 1;
                let mut args = Vec::new();
                if self.peek() == Some(&Tok::RParen) {
                    self.at += 1;
                } else {
                    loop {
                        self.depth += 1;
                        if self.depth > MAX_DEPTH {
                            return err("this formula is nested too deeply", self.pos());
                        }
                        args.push(self.or()?);
                        self.depth -= 1;
                        match self.peek() {
                            Some(Tok::Comma) => self.at += 1,
                            Some(Tok::RParen) => {
                                self.at += 1;
                                break;
                            }
                            _ => {
                                return err("expected a comma or a closing parenthesis", self.pos())
                            }
                        }
                    }
                }
                if name == "prop" {
                    return match args.as_slice() {
                        [Expr::Str(s)] => Ok(Expr::Prop(s.clone(), pos)),
                        _ => err(
                            "prop() takes the property's name in quotes, like prop(\"Price\")",
                            pos,
                        ),
                    };
                }
                Ok(Expr::Call(name, args, pos))
            }
            Tok::RParen => err("unexpected closing parenthesis", pos),
            Tok::Comma => err("unexpected comma", pos),
            Tok::Op(o) => err(format!("unexpected '{o}'"), pos),
        }
    }
}

pub fn parse(src: &str) -> Result<Option<Expr>, FormulaError> {
    if src.chars().count() > MAX_FORMULA_LEN {
        return err(
            format!("formulas can be at most {MAX_FORMULA_LEN} characters"),
            0,
        );
    }
    let toks = tokenize(src)?;
    if toks.is_empty() {
        return Ok(None);
    }
    let mut p = Parser {
        end: src.chars().count(),
        toks,
        at: 0,
        depth: 0,
    };
    let e = p.or()?;
    if p.at < p.toks.len() {
        return err("this part could not be understood", p.pos());
    }
    Ok(Some(e))
}

/// Names of the properties an expression refers to.
pub fn refs(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Prop(n, _) => out.push(n.clone()),
        Expr::Call(_, a, _) => a.iter().for_each(|x| refs(x, out)),
        Expr::Not(x) | Expr::Neg(x) => refs(x, out),
        Expr::Bin(_, a, b, _) => {
            refs(a, out);
            refs(b, out);
        }
        _ => {}
    }
}

/// Rewrites `prop("old")` to `prop("new")`, keeping the rest of the text exactly as written.
pub fn rename_refs(src: &str, old: &str, new: &str) -> String {
    let Ok(toks) = tokenize(src) else {
        return src.to_string();
    };
    let chars: Vec<char> = src.chars().collect();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for w in toks.windows(3) {
        if let (Tok::Ident(f), Tok::LParen, Tok::Str(s)) = (&w[0].tok, &w[1].tok, &w[2].tok) {
            if f == "prop" && s.to_lowercase() == old.to_lowercase() {
                spans.push((w[2].start, w[2].end));
            }
        }
    }
    let quoted = format!("\"{}\"", new.replace('\\', "\\\\").replace('"', "\\\""));
    let mut out = String::new();
    let mut at = 0;
    for (s, e) in spans {
        out.extend(&chars[at..s]);
        out.push_str(&quoted);
        at = e;
    }
    out.extend(&chars[at..]);
    out
}

// ---------------------------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ty {
    Num,
    Text,
    Bool,
    Date,
    List,
    /// Unknown until runtime (an empty formula, a missing property, mixed branches).
    Any,
}

impl Ty {
    pub fn name(self) -> &'static str {
        match self {
            Ty::Num => "number",
            Ty::Text => "text",
            Ty::Bool => "bool",
            Ty::Date => "date",
            Ty::List => "list",
            Ty::Any => "any",
        }
    }
    pub fn from_name(s: &str) -> Ty {
        match s {
            "number" => Ty::Num,
            "text" => Ty::Text,
            "bool" => Ty::Bool,
            "date" => Ty::Date,
            "list" => Ty::List,
            _ => Ty::Any,
        }
    }
}

/// How a property's value reads inside a formula.
pub fn property_ty(p: &Property, formulas: &HashMap<String, Ty>) -> Ty {
    match p.property_type.as_str() {
        "number" | "unique_id" => Ty::Num,
        "checkbox" => Ty::Bool,
        "date" | "created_time" | "updated_time" => Ty::Date,
        "multi_select" | "relation" => Ty::List,
        "rollup" => match p.config.get("function").and_then(Value::as_str) {
            Some("earliest" | "latest") => Ty::Date,
            _ => Ty::Num,
        },
        "formula" => formulas.get(&p.id).copied().unwrap_or(Ty::Any),
        _ => Ty::Text,
    }
}

fn unify(a: Ty, b: Ty) -> Ty {
    if a == b {
        a
    } else {
        Ty::Any
    }
}

const UNITS: [&str; 6] = ["minutes", "hours", "days", "weeks", "months", "years"];

struct Check<'a> {
    props: &'a HashMap<String, Ty>,
    /// When false, unknown properties are tolerated (a formula whose property was deleted).
    strict: bool,
}

impl Check<'_> {
    fn want(&self, got: Ty, wanted: &[Ty], what: &str, pos: usize) -> Result<(), FormulaError> {
        if got == Ty::Any || wanted.contains(&got) {
            Ok(())
        } else {
            err(
                format!(
                    "{what} must be {}, not {}",
                    wanted
                        .iter()
                        .map(|t| t.name())
                        .collect::<Vec<_>>()
                        .join(" or "),
                    got.name()
                ),
                pos,
            )
        }
    }

    fn ty(&self, e: &Expr) -> Result<Ty, FormulaError> {
        Ok(match e {
            Expr::Num(_) => Ty::Num,
            Expr::Str(_) => Ty::Text,
            Expr::Bool(_) => Ty::Bool,
            Expr::Prop(n, pos) => match self.props.get(&n.to_lowercase()) {
                Some(t) => *t,
                None if self.strict => {
                    return err(format!("there is no property named \"{n}\""), *pos)
                }
                None => Ty::Any,
            },
            Expr::Neg(x) => {
                self.want(self.ty(x)?, &[Ty::Num], "a negated value", 0)?;
                Ty::Num
            }
            Expr::Not(x) => {
                self.want(self.ty(x)?, &[Ty::Bool], "the value after 'not'", 0)?;
                Ty::Bool
            }
            Expr::Bin(op, a, b, pos) => {
                let (ta, tb) = (self.ty(a)?, self.ty(b)?);
                match *op {
                    "+" if ta == Ty::Text || tb == Ty::Text => Ty::Text,
                    "+" | "-" | "*" | "/" | "%" => {
                        self.want(ta, &[Ty::Num], &format!("the left side of '{op}'"), *pos)?;
                        self.want(tb, &[Ty::Num], &format!("the right side of '{op}'"), *pos)?;
                        Ty::Num
                    }
                    "&&" | "||" => {
                        self.want(ta, &[Ty::Bool], &format!("the left side of '{op}'"), *pos)?;
                        self.want(tb, &[Ty::Bool], &format!("the right side of '{op}'"), *pos)?;
                        Ty::Bool
                    }
                    _ => {
                        if ta != Ty::Any && tb != Ty::Any && ta != tb {
                            return err(
                                format!("cannot compare {} with {}", ta.name(), tb.name()),
                                *pos,
                            );
                        }
                        Ty::Bool
                    }
                }
            }
            Expr::Call(name, args, pos) => self.call(name, args, *pos)?,
        })
    }

    fn arity(
        &self,
        name: &str,
        args: &[Expr],
        min: usize,
        max: usize,
        pos: usize,
    ) -> Result<(), FormulaError> {
        if args.len() < min || args.len() > max {
            let range = if min == max {
                min.to_string()
            } else if max == usize::MAX {
                format!("at least {min}")
            } else {
                format!("{min} to {max}")
            };
            return err(
                format!(
                    "{name}() takes {range} argument{}",
                    if max == 1 { "" } else { "s" }
                ),
                pos,
            );
        }
        Ok(())
    }

    fn call(&self, name: &str, args: &[Expr], pos: usize) -> Result<Ty, FormulaError> {
        let tys = args
            .iter()
            .map(|a| self.ty(a))
            .collect::<Result<Vec<_>, _>>()?;
        let nth = |i: usize, wanted: &[Ty], what: &str| self.want(tys[i], wanted, what, pos);
        match name {
            "if" => {
                self.arity(name, args, 3, 3, pos)?;
                nth(0, &[Ty::Bool], "the condition of if()")?;
                Ok(unify(tys[1], tys[2]))
            }
            "ifs" => {
                self.arity(name, args, 2, usize::MAX, pos)?;
                let pairs = args.len() / 2;
                for i in 0..pairs {
                    nth(i * 2, &[Ty::Bool], "each condition of ifs()")?;
                }
                let mut out = tys[1];
                for i in 1..pairs {
                    out = unify(out, tys[i * 2 + 1]);
                }
                if args.len() % 2 == 1 {
                    out = unify(out, tys[args.len() - 1]);
                }
                Ok(out)
            }
            "empty" => {
                self.arity(name, args, 1, 1, pos)?;
                Ok(Ty::Bool)
            }
            "length" => {
                self.arity(name, args, 1, 1, pos)?;
                nth(0, &[Ty::Text, Ty::List], "the argument of length()")?;
                Ok(Ty::Num)
            }
            "contains" => {
                self.arity(name, args, 2, 2, pos)?;
                nth(0, &[Ty::Text, Ty::List], "the first argument of contains()")?;
                Ok(Ty::Bool)
            }
            "concat" => {
                self.arity(name, args, 1, usize::MAX, pos)?;
                Ok(Ty::Text)
            }
            "format" => {
                self.arity(name, args, 1, 1, pos)?;
                Ok(Ty::Text)
            }
            "toNumber" => {
                self.arity(name, args, 1, 1, pos)?;
                nth(0, &[Ty::Text, Ty::Num], "the argument of toNumber()")?;
                Ok(Ty::Num)
            }
            "round" => {
                self.arity(name, args, 1, 2, pos)?;
                nth(0, &[Ty::Num], "the first argument of round()")?;
                if args.len() == 2 {
                    nth(1, &[Ty::Num], "the digits of round()")?;
                }
                Ok(Ty::Num)
            }
            "floor" | "ceil" | "abs" => {
                self.arity(name, args, 1, 1, pos)?;
                nth(0, &[Ty::Num], &format!("the argument of {name}()"))?;
                Ok(Ty::Num)
            }
            "min" | "max" => {
                self.arity(name, args, 1, usize::MAX, pos)?;
                for i in 0..args.len() {
                    nth(i, &[Ty::Num], &format!("each argument of {name}()"))?;
                }
                Ok(Ty::Num)
            }
            "now" | "today" => {
                self.arity(name, args, 0, 0, pos)?;
                Ok(Ty::Date)
            }
            "dateAdd" | "dateSubtract" => {
                self.arity(name, args, 3, 3, pos)?;
                nth(0, &[Ty::Date], &format!("the first argument of {name}()"))?;
                nth(1, &[Ty::Num], &format!("the amount of {name}()"))?;
                if let Expr::Str(u) = &args[2] {
                    if !UNITS.contains(&u.as_str()) {
                        return err(format!("the unit must be one of {}", UNITS.join(", ")), pos);
                    }
                } else {
                    nth(2, &[Ty::Text], &format!("the unit of {name}()"))?;
                }
                Ok(Ty::Date)
            }
            "formatDate" => {
                self.arity(name, args, 2, 2, pos)?;
                nth(0, &[Ty::Date], "the first argument of formatDate()")?;
                nth(1, &[Ty::Text], "the format of formatDate()")?;
                Ok(Ty::Text)
            }
            other => self.call_more(other, args, &tys, pos),
        }
    }
}

/// The result type of a formula, or its first error. `props` maps lowercase property names to types.
pub fn check(src: &str, props: &HashMap<String, Ty>, strict: bool) -> Result<Ty, FormulaError> {
    match parse(src)? {
        None => Ok(Ty::Any),
        Some(e) => Check { props, strict }.ty(&e),
    }
}

// ---------------------------------------------------------------------------------------------
// values and evaluation
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Empty,
    Num(f64),
    Text(String),
    Bool(bool),
    /// A day, or a moment when `time` is set.
    Date(NaiveDateTime, bool),
    List(Vec<Val>),
    Err(&'static str),
}

const E_ERROR: &str = "#ERROR";
const E_TYPE: &str = "#TYPE";
const E_REF: &str = "#REF";

pub fn parse_when(s: &str) -> Option<(NaiveDateTime, bool)> {
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).map(|d| (d, false));
    }
    for fmt in [
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
    ] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some((d, true));
        }
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| (d.naive_utc(), true))
}

fn number_text(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        let s = format!("{n:.10}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn date_text(d: &NaiveDateTime, time: bool) -> String {
    if time {
        d.format("%Y-%m-%dT%H:%M").to_string()
    } else {
        d.format("%Y-%m-%d").to_string()
    }
}

fn as_text(v: &Val) -> String {
    match v {
        Val::Empty | Val::Err(_) => String::new(),
        Val::Num(n) => number_text(*n),
        Val::Text(s) => s.clone(),
        Val::Bool(b) => b.to_string(),
        Val::Date(d, t) => date_text(d, *t),
        Val::List(l) => l.iter().map(as_text).collect::<Vec<_>>().join(", "),
    }
}

impl Val {
    /// The JSON stored in a cell: numbers, text, booleans, `{start}` dates, lists of text, `{error}`.
    pub fn to_json(&self) -> Option<Value> {
        match self {
            Val::Empty => None,
            Val::Num(n) if n.is_finite() => Some(json!(n)),
            Val::Num(_) => Some(json!({ "error": E_ERROR })),
            Val::Text(s) => Some(json!(s)),
            Val::Bool(b) => Some(json!(b)),
            Val::Date(d, t) => Some(json!({ "start": date_text(d, *t) })),
            Val::List(l) => Some(json!(l.iter().map(as_text).collect::<Vec<_>>())),
            Val::Err(code) => Some(json!({ "error": code })),
        }
    }
}

pub struct Env<'a> {
    pub now: NaiveDateTime,
    /// Property values by lowercase name.
    pub get: &'a dyn Fn(&str) -> Val,
}

fn truthy(v: &Val) -> Result<bool, &'static str> {
    match v {
        Val::Bool(b) => Ok(*b),
        Val::Empty => Ok(false),
        Val::Err(e) => Err(e),
        _ => Err(E_TYPE),
    }
}

fn num(v: &Val) -> Result<f64, &'static str> {
    match v {
        Val::Num(n) => Ok(*n),
        Val::Err(e) => Err(e),
        _ => Err(E_TYPE),
    }
}

fn is_empty(v: &Val) -> bool {
    match v {
        Val::Empty => true,
        Val::Text(s) => s.is_empty(),
        Val::List(l) => l.is_empty(),
        _ => false,
    }
}

fn date_add(d: &NaiveDateTime, time: bool, amount: f64, unit: &str) -> Option<Val> {
    if !amount.is_finite() || amount.abs() > 1e7 {
        return None;
    }
    let n = amount.trunc() as i64;
    let (out, time) = match unit {
        "minutes" => (d.checked_add_signed(Duration::minutes(n))?, true),
        "hours" => (d.checked_add_signed(Duration::hours(n))?, true),
        "days" => (d.checked_add_signed(Duration::days(n))?, time),
        "weeks" => (d.checked_add_signed(Duration::weeks(n))?, time),
        "months" | "years" => {
            let months = if unit == "years" {
                n.checked_mul(12)?
            } else {
                n
            };
            let m = Months::new(months.unsigned_abs().try_into().ok()?);
            let moved = if months >= 0 {
                d.checked_add_months(m)?
            } else {
                d.checked_sub_months(m)?
            };
            (moved, time)
        }
        _ => return None,
    };
    Some(Val::Date(out, time))
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn format_date(d: &NaiveDateTime, fmt: &str) -> String {
    let chars: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let at = |i: usize, t: &str| chars[i..].iter().take(t.len()).collect::<String>() == t;
    while i < chars.len() {
        let (text, skip) = if at(i, "YYYY") {
            (format!("{:04}", d.year()), 4)
        } else if at(i, "MMMM") {
            (MONTHS[d.month0() as usize].to_string(), 4)
        } else if at(i, "MMM") {
            (MONTHS[d.month0() as usize][..3].to_string(), 3)
        } else if at(i, "MM") {
            (format!("{:02}", d.month()), 2)
        } else if at(i, "DD") {
            (format!("{:02}", d.day()), 2)
        } else if at(i, "HH") {
            (format!("{:02}", d.hour()), 2)
        } else if at(i, "mm") {
            (format!("{:02}", d.minute()), 2)
        } else {
            (chars[i].to_string(), 1)
        };
        out.push_str(&text);
        i += skip;
    }
    out
}

fn compare(a: &Val, b: &Val) -> Option<std::cmp::Ordering> {
    match (a, b) {
        (Val::Num(x), Val::Num(y)) => x.partial_cmp(y),
        (Val::Text(x), Val::Text(y)) => Some(x.to_lowercase().cmp(&y.to_lowercase())),
        (Val::Bool(x), Val::Bool(y)) => Some(x.cmp(y)),
        (Val::Date(x, _), Val::Date(y, _)) => Some(x.cmp(y)),
        _ => None,
    }
}

pub fn eval(e: &Expr, env: &Env) -> Val {
    match run(e, env, 0) {
        Ok(v) => v,
        Err(code) => Val::Err(code),
    }
}

fn run(e: &Expr, env: &Env, depth: usize) -> Result<Val, &'static str> {
    if depth > 200 {
        return Err(E_ERROR);
    }
    let go = |x: &Expr| run(x, env, depth + 1);
    Ok(match e {
        Expr::Num(n) => Val::Num(*n),
        Expr::Str(s) => Val::Text(s.clone()),
        Expr::Bool(b) => Val::Bool(*b),
        Expr::Prop(name, _) => match (env.get)(&name.to_lowercase()) {
            Val::Err(c) => return Err(c),
            v => v,
        },
        Expr::Neg(x) => Val::Num(-num(&go(x)?)?),
        Expr::Not(x) => Val::Bool(!truthy(&go(x)?)?),
        Expr::Bin(op, a, b, _) => {
            let (l, r) = match *op {
                "&&" | "||" => {
                    let l = truthy(&go(a)?)?;
                    if (*op == "&&" && !l) || (*op == "||" && l) {
                        return Ok(Val::Bool(l));
                    }
                    return Ok(Val::Bool(truthy(&go(b)?)?));
                }
                _ => (go(a)?, go(b)?),
            };
            match *op {
                "+" if matches!(l, Val::Text(_)) || matches!(r, Val::Text(_)) => {
                    Val::Text(format!("{}{}", as_text(&l), as_text(&r)))
                }
                "+" | "-" | "*" | "/" | "%" => {
                    let (x, y) = (num(&l)?, num(&r)?);
                    if matches!(*op, "/" | "%") && y == 0.0 {
                        return Err(E_ERROR);
                    }
                    Val::Num(match *op {
                        "+" => x + y,
                        "-" => x - y,
                        "*" => x * y,
                        "/" => x / y,
                        _ => x % y,
                    })
                }
                "==" | "!=" => {
                    if let Val::Err(c) = l {
                        return Err(c);
                    }
                    if let Val::Err(c) = r {
                        return Err(c);
                    }
                    let same = match (&l, &r) {
                        (Val::Empty, Val::Empty) => true,
                        (Val::Empty, o) | (o, Val::Empty) => is_empty(o),
                        _ => compare(&l, &r) == Some(std::cmp::Ordering::Equal),
                    };
                    Val::Bool(same == (*op == "=="))
                }
                _ => {
                    if let Val::Err(c) = l {
                        return Err(c);
                    }
                    if let Val::Err(c) = r {
                        return Err(c);
                    }
                    if is_empty(&l) || is_empty(&r) {
                        return Ok(Val::Bool(false));
                    }
                    let Some(o) = compare(&l, &r) else {
                        return Err(E_TYPE);
                    };
                    Val::Bool(match *op {
                        "<" => o.is_lt(),
                        "<=" => o.is_le(),
                        ">" => o.is_gt(),
                        _ => o.is_ge(),
                    })
                }
            }
        }
        Expr::Call(name, args, _) => call(name, args, env, depth)?,
    })
}

fn call(name: &str, args: &[Expr], env: &Env, depth: usize) -> Result<Val, &'static str> {
    let go = |x: &Expr| run(x, env, depth + 1);
    Ok(match name {
        "if" => {
            if truthy(&go(&args[0])?)? {
                go(&args[1])?
            } else {
                go(&args[2])?
            }
        }
        "ifs" => {
            let pairs = args.len() / 2;
            for i in 0..pairs {
                if truthy(&go(&args[i * 2])?)? {
                    return go(&args[i * 2 + 1]);
                }
            }
            if args.len() % 2 == 1 {
                go(&args[args.len() - 1])?
            } else {
                Val::Empty
            }
        }
        "empty" => Val::Bool(is_empty(&go(&args[0])?)),
        "length" => match go(&args[0])? {
            Val::Text(s) => Val::Num(s.chars().count() as f64),
            Val::List(l) => Val::Num(l.len() as f64),
            Val::Empty => Val::Num(0.0),
            _ => return Err(E_TYPE),
        },
        "contains" => {
            let needle = go(&args[1])?;
            match go(&args[0])? {
                Val::Text(s) => {
                    Val::Bool(s.to_lowercase().contains(&as_text(&needle).to_lowercase()))
                }
                Val::List(l) => Val::Bool(
                    l.iter()
                        .any(|v| compare(v, &needle) == Some(std::cmp::Ordering::Equal)),
                ),
                Val::Empty => Val::Bool(false),
                _ => return Err(E_TYPE),
            }
        }
        "concat" => {
            let mut out = String::new();
            for a in args {
                out.push_str(&as_text(&go(a)?));
            }
            Val::Text(out)
        }
        "format" => Val::Text(as_text(&go(&args[0])?)),
        "toNumber" => match go(&args[0])? {
            Val::Num(n) => Val::Num(n),
            Val::Text(s) => s
                .trim()
                .replace(',', "")
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .map_or(Val::Empty, Val::Num),
            Val::Empty => Val::Empty,
            _ => return Err(E_TYPE),
        },
        "round" => {
            let n = num(&go(&args[0])?)?;
            let digits = if args.len() == 2 {
                num(&go(&args[1])?)?.clamp(-10.0, 10.0).trunc()
            } else {
                0.0
            };
            let f = 10f64.powi(digits as i32);
            Val::Num((n * f).round() / f)
        }
        "floor" => Val::Num(num(&go(&args[0])?)?.floor()),
        "ceil" => Val::Num(num(&go(&args[0])?)?.ceil()),
        "abs" => Val::Num(num(&go(&args[0])?)?.abs()),
        "min" | "max" => {
            let mut best: Option<f64> = None;
            for a in args {
                let n = num(&go(a)?)?;
                best = Some(match best {
                    None => n,
                    Some(b) if name == "min" => b.min(n),
                    Some(b) => b.max(n),
                });
            }
            best.map_or(Val::Empty, Val::Num)
        }
        "now" => Val::Date(env.now, true),
        "today" => Val::Date(env.now.date().and_time(NaiveTime::MIN), false),
        "dateAdd" | "dateSubtract" => {
            let (d, amount, unit) = (go(&args[0])?, go(&args[1])?, go(&args[2])?);
            let (Val::Date(d, time), Val::Text(unit)) = (&d, &unit) else {
                return if matches!(d, Val::Empty) {
                    Ok(Val::Empty)
                } else {
                    Err(E_TYPE)
                };
            };
            let n = num(&amount)?;
            date_add(d, *time, if name == "dateAdd" { n } else { -n }, unit).ok_or(E_ERROR)?
        }
        "formatDate" => match (go(&args[0])?, go(&args[1])?) {
            (Val::Date(d, _), Val::Text(f)) => Val::Text(format_date(&d, &f)),
            (Val::Empty, _) => Val::Empty,
            _ => return Err(E_TYPE),
        },
        _ => return call_more(name, args, env, depth),
    })
}

/// Converts a stored cell into a formula value, given the property it belongs to.
pub fn from_cell(p: &Property, v: Option<&Value>, title: &str, unique_id: i64) -> Val {
    let option_name = |id: &Value| -> Val {
        p.config
            .get("options")
            .and_then(Value::as_array)
            .and_then(|o| o.iter().find(|o| o.get("id") == Some(id)))
            .and_then(|o| o.get("name").and_then(Value::as_str))
            .map_or(Val::Empty, |n| Val::Text(n.to_string()))
    };
    match p.property_type.as_str() {
        "title" => Val::Text(title.to_string()),
        "unique_id" => Val::Num(unique_id as f64),
        "checkbox" => Val::Bool(v.and_then(Value::as_bool) == Some(true)),
        _ => {
            let Some(v) = v else { return Val::Empty };
            match p.property_type.as_str() {
                "number" => v.as_f64().map_or(Val::Empty, Val::Num),
                "select" | "status" => option_name(v),
                "multi_select" => Val::List(
                    v.as_array()
                        .map(|a| a.iter().map(option_name).collect())
                        .unwrap_or_default(),
                ),
                "relation" => Val::List(
                    v.as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|l| l.get("title").and_then(Value::as_str))
                                .map(|t| Val::Text(t.to_string()))
                                .collect()
                        })
                        .unwrap_or_default(),
                ),
                "date" => v
                    .get("start")
                    .and_then(Value::as_str)
                    .and_then(parse_when)
                    .map_or(Val::Empty, |(d, t)| Val::Date(d, t)),
                "rollup" | "formula" => match v {
                    Value::Number(n) => n.as_f64().map_or(Val::Empty, Val::Num),
                    Value::String(s) => {
                        parse_when(s).map_or_else(|| Val::Text(s.clone()), |(d, t)| Val::Date(d, t))
                    }
                    Value::Bool(b) => Val::Bool(*b),
                    Value::Object(o) if o.contains_key("error") => Val::Err(E_REF),
                    Value::Object(o) => o
                        .get("start")
                        .and_then(Value::as_str)
                        .and_then(parse_when)
                        .map_or(Val::Empty, |(d, t)| Val::Date(d, t)),
                    Value::Array(a) => Val::List(
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(|s| Val::Text(s.to_string()))
                            .collect(),
                    ),
                    Value::Null => Val::Empty,
                },
                _ => v.as_str().map_or(Val::Empty, |s| Val::Text(s.to_string())),
            }
        }
    }
}

/// Property names in an expression that no longer exist, for the `#REF` check.
pub fn missing_refs(e: &Expr, known: &HashSet<String>) -> bool {
    let mut names = Vec::new();
    refs(e, &mut names);
    names.iter().any(|n| !known.contains(&n.to_lowercase()))
}

pub fn missing_ref_value() -> Val {
    Val::Err(E_REF)
}

// ---------------------------------------------------------------------------------------------
// more functions: logic, maths, text, dates and lists
// ---------------------------------------------------------------------------------------------

/// Units accepted by `dateBetween` (plural, as in `dateAdd`) and `startOf`/`endOf`; the singular
/// form of each is accepted too.
const BETWEEN_UNITS: [&str; 6] = UNITS;
const EDGE_UNITS: [&str; 4] = ["days", "weeks", "months", "years"];

fn canon_unit(u: &str, allowed: &[&'static str]) -> Option<&'static str> {
    allowed
        .iter()
        .copied()
        .find(|a| *a == u || a.strip_suffix('s') == Some(u))
}

const MAX_PAD: i64 = 10_000;

impl Check<'_> {
    fn unit(
        &self,
        e: &Expr,
        ty: Ty,
        allowed: &[&'static str],
        what: &str,
        pos: usize,
    ) -> Result<(), FormulaError> {
        if let Expr::Str(u) = e {
            if canon_unit(u, allowed).is_none() {
                let names: Vec<String> = allowed
                    .iter()
                    .map(|a| a.trim_end_matches('s').to_string())
                    .collect();
                return err(
                    format!("the unit of {what}() must be one of {}", names.join(", ")),
                    pos,
                );
            }
            Ok(())
        } else {
            self.want(ty, &[Ty::Text], &format!("the unit of {what}()"), pos)
        }
    }

    fn call_more(
        &self,
        name: &str,
        args: &[Expr],
        tys: &[Ty],
        pos: usize,
    ) -> Result<Ty, FormulaError> {
        let nth = |i: usize, wanted: &[Ty], what: &str| self.want(tys[i], wanted, what, pos);
        let each = |wanted: &[Ty], what: &str| -> Result<(), FormulaError> {
            tys.iter()
                .try_for_each(|t| self.want(*t, wanted, what, pos))
        };
        let unify_all = |idx: Vec<usize>| -> Ty {
            let mut out: Option<Ty> = None;
            for i in idx {
                out = Some(out.map_or(tys[i], |o| unify(o, tys[i])));
            }
            out.unwrap_or(Ty::Any)
        };
        match name {
            // logic
            "and" | "or" => {
                self.arity(name, args, 1, usize::MAX, pos)?;
                each(&[Ty::Bool], &format!("each argument of {name}()"))?;
                Ok(Ty::Bool)
            }
            "not" => {
                self.arity(name, args, 1, 1, pos)?;
                nth(0, &[Ty::Bool], "the argument of not()")?;
                Ok(Ty::Bool)
            }
            "switch" => {
                self.arity(name, args, 3, usize::MAX, pos)?;
                let pairs = (args.len() - 1) / 2;
                for k in 0..pairs {
                    let c = tys[1 + 2 * k];
                    if tys[0] != Ty::Any && c != Ty::Any && c != tys[0] {
                        return err(
                            format!(
                                "cannot compare {} with {} in switch()",
                                tys[0].name(),
                                c.name()
                            ),
                            pos,
                        );
                    }
                }
                let mut idx: Vec<usize> = (0..pairs).map(|k| 2 + 2 * k).collect();
                if args.len() % 2 == 0 {
                    idx.push(args.len() - 1);
                }
                Ok(unify_all(idx))
            }
            "iferror" => {
                self.arity(name, args, 2, 2, pos)?;
                Ok(unify(tys[0], tys[1]))
            }
            "coalesce" => {
                self.arity(name, args, 2, usize::MAX, pos)?;
                Ok(unify_all((0..args.len()).collect()))
            }
            // maths
            "mod" | "pow" => {
                self.arity(name, args, 2, 2, pos)?;
                each(&[Ty::Num], &format!("each argument of {name}()"))?;
                Ok(Ty::Num)
            }
            "sqrt" | "ln" | "log10" | "sign" => {
                self.arity(name, args, 1, 1, pos)?;
                nth(0, &[Ty::Num], &format!("the argument of {name}()"))?;
                Ok(Ty::Num)
            }
            "sum" | "average" | "median" => {
                self.arity(name, args, 1, usize::MAX, pos)?;
                each(&[Ty::Num, Ty::List], &format!("each argument of {name}()"))?;
                Ok(Ty::Num)
            }
            // text
            "lower" | "upper" | "trim" => {
                self.arity(name, args, 1, 1, pos)?;
                nth(0, &[Ty::Text], &format!("the argument of {name}()"))?;
                Ok(Ty::Text)
            }
            "replace" | "replaceAll" => {
                self.arity(name, args, 3, 3, pos)?;
                each(&[Ty::Text], &format!("each argument of {name}()"))?;
                Ok(Ty::Text)
            }
            "left" | "right" => {
                self.arity(name, args, 2, 2, pos)?;
                nth(0, &[Ty::Text], &format!("the first argument of {name}()"))?;
                nth(1, &[Ty::Num], &format!("the length of {name}()"))?;
                Ok(Ty::Text)
            }
            "mid" => {
                self.arity(name, args, 3, 3, pos)?;
                nth(0, &[Ty::Text], "the first argument of mid()")?;
                nth(1, &[Ty::Num], "the start of mid()")?;
                nth(2, &[Ty::Num], "the length of mid()")?;
                Ok(Ty::Text)
            }
            "split" => {
                self.arity(name, args, 2, 2, pos)?;
                each(&[Ty::Text], "each argument of split()")?;
                Ok(Ty::List)
            }
            "join" => {
                self.arity(name, args, 1, 2, pos)?;
                nth(0, &[Ty::List], "the first argument of join()")?;
                if args.len() == 2 {
                    nth(1, &[Ty::Text], "the separator of join()")?;
                }
                Ok(Ty::Text)
            }
            "startsWith" | "endsWith" => {
                self.arity(name, args, 2, 2, pos)?;
                each(&[Ty::Text], &format!("each argument of {name}()"))?;
                Ok(Ty::Bool)
            }
            "padStart" => {
                self.arity(name, args, 2, 3, pos)?;
                nth(0, &[Ty::Text, Ty::Num], "the first argument of padStart()")?;
                nth(1, &[Ty::Num], "the length of padStart()")?;
                if args.len() == 3 {
                    nth(2, &[Ty::Text], "the padding of padStart()")?;
                }
                Ok(Ty::Text)
            }
            // dates
            "year" | "month" | "day" | "weekday" | "week" => {
                self.arity(name, args, 1, 1, pos)?;
                nth(0, &[Ty::Date], &format!("the argument of {name}()"))?;
                Ok(Ty::Num)
            }
            "dateBetween" => {
                self.arity(name, args, 3, 3, pos)?;
                nth(0, &[Ty::Date], "the first argument of dateBetween()")?;
                nth(1, &[Ty::Date], "the second argument of dateBetween()")?;
                self.unit(&args[2], tys[2], &BETWEEN_UNITS, name, pos)?;
                Ok(Ty::Num)
            }
            "startOf" | "endOf" => {
                self.arity(name, args, 2, 2, pos)?;
                nth(0, &[Ty::Date], &format!("the first argument of {name}()"))?;
                self.unit(&args[1], tys[1], &EDGE_UNITS, name, pos)?;
                Ok(Ty::Date)
            }
            // lists
            "first" | "last" => {
                self.arity(name, args, 1, 1, pos)?;
                nth(0, &[Ty::List], &format!("the argument of {name}()"))?;
                Ok(Ty::Any)
            }
            "at" => {
                self.arity(name, args, 2, 2, pos)?;
                nth(0, &[Ty::List], "the first argument of at()")?;
                nth(1, &[Ty::Num], "the index of at()")?;
                Ok(Ty::Any)
            }
            "unique" | "sort" => {
                self.arity(name, args, 1, 1, pos)?;
                nth(0, &[Ty::List], &format!("the argument of {name}()"))?;
                Ok(Ty::List)
            }
            other => err(format!("there is no function named {other}()"), pos),
        }
    }
}

fn txt(v: &Val) -> Result<String, &'static str> {
    match v {
        Val::Text(s) => Ok(s.clone()),
        Val::Empty => Ok(String::new()),
        Val::Err(e) => Err(e),
        _ => Err(E_TYPE),
    }
}

fn int(v: &Val) -> Result<i64, &'static str> {
    let n = num(v)?;
    if n.is_finite() {
        Ok(n.trunc().clamp(-1e9, 1e9) as i64)
    } else {
        Err(E_ERROR)
    }
}

fn finite(n: f64) -> Result<Val, &'static str> {
    if n.is_finite() {
        Ok(Val::Num(n))
    } else {
        Err(E_ERROR)
    }
}

fn date_of(v: &Val) -> Result<Option<(NaiveDateTime, bool)>, &'static str> {
    match v {
        Val::Date(d, t) => Ok(Some((*d, *t))),
        Val::Empty => Ok(None),
        Val::Err(e) => Err(e),
        _ => Err(E_TYPE),
    }
}

fn unit_of(v: &Val, allowed: &[&'static str]) -> Result<&'static str, &'static str> {
    match v {
        Val::Text(u) => canon_unit(u, allowed).ok_or(E_ERROR),
        Val::Err(e) => Err(e),
        _ => Err(E_TYPE),
    }
}

/// Numbers from a mix of numbers and lists; empty values and non-numeric list items are skipped.
fn numbers(vals: &[Val]) -> Result<Vec<f64>, &'static str> {
    let mut out = Vec::new();
    for v in vals {
        match v {
            Val::Num(n) => out.push(*n),
            Val::Empty => {}
            Val::List(l) => {
                for x in l {
                    match x {
                        Val::Num(n) => out.push(*n),
                        Val::Text(s) => {
                            if let Some(n) = s
                                .trim()
                                .replace(',', "")
                                .parse::<f64>()
                                .ok()
                                .filter(|n| n.is_finite())
                            {
                                out.push(n);
                            }
                        }
                        Val::Err(e) => return Err(e),
                        _ => {}
                    }
                }
            }
            Val::Err(e) => return Err(e),
            _ => return Err(E_TYPE),
        }
    }
    Ok(out)
}

fn start_of(d: &NaiveDateTime, unit: &str) -> Option<NaiveDateTime> {
    let day = d.date();
    let start = match unit {
        "days" => day,
        "weeks" => {
            day.checked_sub_signed(Duration::days(day.weekday().num_days_from_monday().into()))?
        }
        "months" => day.with_day(1)?,
        _ => NaiveDate::from_ymd_opt(day.year(), 1, 1)?,
    };
    Some(start.and_time(NaiveTime::MIN))
}

fn months_between(a: &NaiveDateTime, b: &NaiveDateTime) -> i64 {
    let mut m = (i64::from(a.year()) - i64::from(b.year())) * 12 + i64::from(a.month())
        - i64::from(b.month());
    if m > 0 {
        if b.checked_add_months(Months::new(m as u32))
            .is_some_and(|x| x > *a)
        {
            m -= 1;
        }
    } else if m < 0
        && b.checked_sub_months(Months::new((-m) as u32))
            .is_some_and(|x| x < *a)
    {
        m += 1;
    }
    m
}

fn call_more(name: &str, args: &[Expr], env: &Env, depth: usize) -> Result<Val, &'static str> {
    let go = |x: &Expr| run(x, env, depth + 1);
    let all = || args.iter().map(go).collect::<Result<Vec<_>, _>>();
    Ok(match name {
        // logic
        "and" | "or" => {
            let want = name == "or";
            for a in args {
                if truthy(&go(a)?)? == want {
                    return Ok(Val::Bool(want));
                }
            }
            Val::Bool(!want)
        }
        "not" => Val::Bool(!truthy(&go(&args[0])?)?),
        "switch" => {
            let v = go(&args[0])?;
            for k in 0..(args.len() - 1) / 2 {
                let c = go(&args[1 + 2 * k])?;
                let same = match (&v, &c) {
                    (Val::Empty, Val::Empty) => true,
                    (Val::Empty, o) | (o, Val::Empty) => is_empty(o),
                    _ => compare(&v, &c) == Some(std::cmp::Ordering::Equal),
                };
                if same {
                    return go(&args[2 + 2 * k]);
                }
            }
            if args.len() % 2 == 0 {
                go(&args[args.len() - 1])?
            } else {
                Val::Empty
            }
        }
        "iferror" => match go(&args[0]) {
            Ok(Val::Err(_)) | Err(_) => go(&args[1])?,
            Ok(v) => v,
        },
        "coalesce" => {
            for a in args {
                let v = go(a)?;
                if !is_empty(&v) {
                    return Ok(v);
                }
            }
            Val::Empty
        }
        // maths
        "mod" => {
            let (x, y) = (num(&go(&args[0])?)?, num(&go(&args[1])?)?);
            if y == 0.0 {
                return Err(E_ERROR);
            }
            finite(x - y * (x / y).floor())?
        }
        "pow" => finite(num(&go(&args[0])?)?.powf(num(&go(&args[1])?)?))?,
        "sqrt" | "ln" | "log10" => {
            let x = num(&go(&args[0])?)?;
            match name {
                "sqrt" if x >= 0.0 => Val::Num(x.sqrt()),
                "ln" if x > 0.0 => Val::Num(x.ln()),
                "log10" if x > 0.0 => Val::Num(x.log10()),
                _ => return Err(E_ERROR),
            }
        }
        "sign" => {
            let x = num(&go(&args[0])?)?;
            Val::Num(if x > 0.0 {
                1.0
            } else if x < 0.0 {
                -1.0
            } else {
                0.0
            })
        }
        "sum" | "average" | "median" => {
            let mut n = numbers(&all()?)?;
            match name {
                "sum" => finite(n.iter().sum())?,
                _ if n.is_empty() => Val::Empty,
                "average" => finite(n.iter().sum::<f64>() / n.len() as f64)?,
                _ => {
                    n.sort_by(|a, b| a.total_cmp(b));
                    let m = n.len() / 2;
                    Val::Num(if n.len() % 2 == 1 {
                        n[m]
                    } else {
                        (n[m - 1] + n[m]) / 2.0
                    })
                }
            }
        }
        // text
        "lower" => Val::Text(txt(&go(&args[0])?)?.to_lowercase()),
        "upper" => Val::Text(txt(&go(&args[0])?)?.to_uppercase()),
        "trim" => Val::Text(txt(&go(&args[0])?)?.trim().to_string()),
        "replace" | "replaceAll" => {
            let (s, find, with) = (
                txt(&go(&args[0])?)?,
                txt(&go(&args[1])?)?,
                txt(&go(&args[2])?)?,
            );
            if find.is_empty() {
                Val::Text(s)
            } else if name == "replace" {
                Val::Text(s.replacen(&find, &with, 1))
            } else {
                Val::Text(s.replace(&find, &with))
            }
        }
        "left" | "right" => {
            let (s, n) = (txt(&go(&args[0])?)?, int(&go(&args[1])?)?);
            if n < 0 {
                return Err(E_ERROR);
            }
            let n = n as usize;
            let count = s.chars().count();
            Val::Text(if name == "left" {
                s.chars().take(n).collect()
            } else {
                s.chars().skip(count.saturating_sub(n)).collect()
            })
        }
        "mid" => {
            let (s, start, n) = (
                txt(&go(&args[0])?)?,
                int(&go(&args[1])?)?,
                int(&go(&args[2])?)?,
            );
            if start < 1 || n < 0 {
                return Err(E_ERROR);
            }
            Val::Text(
                s.chars()
                    .skip(start as usize - 1)
                    .take(n as usize)
                    .collect(),
            )
        }
        "split" => {
            let (s, sep) = (txt(&go(&args[0])?)?, txt(&go(&args[1])?)?);
            Val::List(if s.is_empty() {
                Vec::new()
            } else if sep.is_empty() {
                s.chars().map(|c| Val::Text(c.to_string())).collect()
            } else {
                s.split(&sep).map(|p| Val::Text(p.to_string())).collect()
            })
        }
        "join" => {
            let sep = if args.len() == 2 {
                txt(&go(&args[1])?)?
            } else {
                ", ".to_string()
            };
            match go(&args[0])? {
                Val::List(l) => Val::Text(l.iter().map(as_text).collect::<Vec<_>>().join(&sep)),
                Val::Empty => Val::Text(String::new()),
                Val::Err(e) => return Err(e),
                _ => return Err(E_TYPE),
            }
        }
        "startsWith" | "endsWith" => {
            let (s, p) = (
                txt(&go(&args[0])?)?.to_lowercase(),
                txt(&go(&args[1])?)?.to_lowercase(),
            );
            Val::Bool(if name == "startsWith" {
                s.starts_with(&p)
            } else {
                s.ends_with(&p)
            })
        }
        "padStart" => {
            let s = match go(&args[0])? {
                Val::Num(n) => number_text(n),
                other => txt(&other)?,
            };
            let width = int(&go(&args[1])?)?;
            let pad = if args.len() == 3 {
                txt(&go(&args[2])?)?
            } else {
                " ".to_string()
            };
            if !(0..=MAX_PAD).contains(&width) {
                return Err(E_ERROR);
            }
            let missing = (width as usize).saturating_sub(s.chars().count());
            if pad.is_empty() || missing == 0 {
                Val::Text(s)
            } else {
                let fill: String = pad.chars().cycle().take(missing).collect();
                Val::Text(fill + &s)
            }
        }
        // dates
        "year" | "month" | "day" | "weekday" | "week" => {
            let Some((d, _)) = date_of(&go(&args[0])?)? else {
                return Ok(Val::Empty);
            };
            Val::Num(match name {
                "year" => f64::from(d.year()),
                "month" => f64::from(d.month()),
                "day" => f64::from(d.day()),
                // Monday is 1, Sunday is 7.
                "weekday" => f64::from(d.weekday().number_from_monday()),
                _ => f64::from(d.iso_week().week()),
            })
        }
        "dateBetween" => {
            let (a, b, unit) = (go(&args[0])?, go(&args[1])?, go(&args[2])?);
            let (a, b) = (date_of(&a)?, date_of(&b)?);
            let unit = unit_of(&unit, &BETWEEN_UNITS)?;
            let (Some((a, _)), Some((b, _))) = (a, b) else {
                return Ok(Val::Empty);
            };
            let span = a.signed_duration_since(b);
            Val::Num(match unit {
                "minutes" => span.num_minutes(),
                "hours" => span.num_hours(),
                "days" => span.num_days(),
                "weeks" => span.num_days() / 7,
                "months" => months_between(&a, &b),
                _ => months_between(&a, &b) / 12,
            } as f64)
        }
        "startOf" | "endOf" => {
            let (d, unit) = (go(&args[0])?, go(&args[1])?);
            let d = date_of(&d)?;
            let unit = unit_of(&unit, &EDGE_UNITS)?;
            let Some((d, time)) = d else {
                return Ok(Val::Empty);
            };
            let start = start_of(&d, unit).ok_or(E_ERROR)?;
            if name == "startOf" {
                Val::Date(start, time)
            } else {
                let Some(Val::Date(next, _)) = date_add(&start, time, 1.0, unit) else {
                    return Err(E_ERROR);
                };
                let end = if time {
                    next.checked_sub_signed(Duration::minutes(1))
                } else {
                    next.checked_sub_signed(Duration::days(1))
                };
                Val::Date(end.ok_or(E_ERROR)?, time)
            }
        }
        // lists
        "first" | "last" | "at" => {
            let l = match go(&args[0])? {
                Val::List(l) => l,
                Val::Empty => Vec::new(),
                Val::Err(e) => return Err(e),
                _ => return Err(E_TYPE),
            };
            let i = match name {
                "first" => 0,
                "last" => l.len() as i64 - 1,
                _ => {
                    let i = int(&go(&args[1])?)?;
                    if i < 0 {
                        l.len() as i64 + i
                    } else {
                        i
                    }
                }
            };
            usize::try_from(i)
                .ok()
                .and_then(|i| l.get(i))
                .cloned()
                .unwrap_or(Val::Empty)
        }
        "unique" => match go(&args[0])? {
            Val::List(l) => {
                let mut out: Vec<Val> = Vec::new();
                for v in l {
                    let dup = out
                        .iter()
                        .any(|o| *o == v || compare(o, &v) == Some(std::cmp::Ordering::Equal));
                    if !dup {
                        out.push(v);
                    }
                }
                Val::List(out)
            }
            Val::Empty => Val::List(Vec::new()),
            Val::Err(e) => return Err(e),
            _ => return Err(E_TYPE),
        },
        "sort" => match go(&args[0])? {
            Val::List(mut l) => {
                l.retain(|v| !matches!(v, Val::Empty));
                let kind = |v: &Val| match v {
                    Val::Num(_) => 1,
                    Val::Text(_) => 2,
                    Val::Bool(_) => 3,
                    Val::Date(..) => 4,
                    _ => 0,
                };
                if l.iter().any(|v| kind(v) == 0 || kind(v) != kind(&l[0])) {
                    return Err(E_TYPE);
                }
                l.sort_by(|a, b| match (a, b) {
                    (Val::Num(x), Val::Num(y)) => x.total_cmp(y),
                    _ => compare(a, b).unwrap_or(std::cmp::Ordering::Equal),
                });
                Val::List(l)
            }
            Val::Empty => Val::List(Vec::new()),
            Val::Err(e) => return Err(e),
            _ => return Err(E_TYPE),
        },
        _ => return Err(E_ERROR),
    })
}
