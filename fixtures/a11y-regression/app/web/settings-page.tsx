import { IconButton } from '../ui/icon-button';

export interface SettingsHeaderProps {
  onOpenSettings: () => void;
}

/**
 * Workspace settings header. The gear control must remain reachable by its
 * accessible name ("Open settings") — keyboard and screen reader users have
 * no visible text to target on an icon-only button.
 */
export function SettingsHeader({ onOpenSettings }: SettingsHeaderProps) {
  return (
    <header className="settings-header">
      <h1>Workspace settings</h1>
      <div className="settings-actions">
        <IconButton
          label="Open settings"
          icon={<span aria-hidden="true">⚙</span>}
          onClick={onOpenSettings}
        />
      </div>
    </header>
  );
}
