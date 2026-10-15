"""Saved v0.1.4 data for the disposable Windows installer acceptance check."""
import hashlib
import json
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

mode, data_arg, fixture_arg = sys.argv[1:]
data, fixture = Path(data_arg), Path(fixture_arg)
db = sqlite3.connect(data / "workspace.db")
db.execute("PRAGMA foreign_keys=ON")

if mode == "seed":
    assert db.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 13
    now = datetime.now(timezone.utc).isoformat()
    for name in ("Installer check", "Second preserved workspace"):
        workspace, page, block = (str(uuid.uuid4()) for _ in range(3))
        db.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES(?,?,?,?)", (workspace, name, now, now))
        db.execute("INSERT INTO page(id,workspace_id,title,created_at,updated_at) VALUES(?,?,?,?,?)", (page, workspace, name + " page", now, now))
        db.execute("INSERT INTO block(id,page_id,type,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?)", (block, page, "paragraph", json.dumps({"html": "<p>Saved before installing 0.1.5.</p>"}), now, now))
    content = b"Attachment preserved across the installer upgrade.\n"
    digest = hashlib.sha256(content).hexdigest()
    blob = data / "attachments" / digest[:2] / digest
    blob.parent.mkdir(parents=True, exist_ok=True)
    blob.write_bytes(content)
    db.execute("INSERT INTO attachment(id,workspace_id,hash,original_name,mime_type,size,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), workspace, digest, "preserve.txt", "text/plain", len(content), now, now))
    db.commit()
    columns = {"workspace": "id,name", "page": "id,workspace_id,title", "block": "id,page_id,type,data_json", "attachment": "id,workspace_id,hash,original_name,mime_type,size"}
    fixture.write_text(json.dumps({"columns": columns, "rows": {table: db.execute(f"SELECT {cols} FROM {table}").fetchall() for table, cols in columns.items()}, "hash": digest}), encoding="utf8")
    print("Saved two workspace fixtures, pages, blocks and an attachment at schema 13.")
elif mode == "verify":
    saved = json.loads(fixture.read_text(encoding="utf8"))
    assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    assert db.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] > 13
    for table, rows in saved["rows"].items():
        for row in rows:
            found = db.execute(f"SELECT {saved['columns'][table]} FROM {table} WHERE id=?", (row[0],)).fetchone()
            assert found is not None and list(found) == row, (table, row[0], found)
    digest = saved["hash"]
    assert hashlib.sha256((data / "attachments" / digest[:2] / digest).read_bytes()).hexdigest() == digest
    snapshots = list((data / "backups" / "pre-migration").glob("workspace-v13-*.db"))
    assert snapshots, "Upgrade must save a pre-migration safety snapshot."
    with sqlite3.connect(snapshots[0]) as snapshot:
        assert snapshot.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert snapshot.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 13
    print("Preserved all baseline workspaces/pages/blocks/files; migrated database and safety snapshot are healthy.")
else:
    raise ValueError(mode)
db.close()
