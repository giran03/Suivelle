import type { ReactNode } from "react";
import { Icon, type IconName } from "../../components/Icon";

/**
 * A titled group of settings: a quiet heading with one line saying what it covers, then the rows in a
 * single card with hairline dividers between them (the Octopolis settings layout).
 */
export function SettingsSection({ title, hint, icon, children }: { title: string; hint?: string; icon?: IconName; children: ReactNode }) {
  return (
    <section className="set-section">
      <header className="set-section-head">
        <h4 className="set-section-title">{icon && <Icon name={icon} size={15} />}<span>{title}</span></h4>
        {hint && <p className="set-section-hint">{hint}</p>}
      </header>
      <div className="set-card">{children}</div>
    </section>
  );
}

/** One sentence under a page title that says what the page is for. */
export function PageNote({ children }: { children: ReactNode }) {
  return <p className="set-page-note">{children}</p>;
}
