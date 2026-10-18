import type { Tool } from '../state/workspace';
import { useWorkspace } from '../state/workspace';
import { Icon, type IconName } from '../components/Icon';

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: IconName }> = [
  { id: 'select', label: 'Select & move', key: 'V', icon: 'select' },
  { id: 'add', label: 'Add intersection', key: 'A', icon: 'add' },
  { id: 'connect', label: 'Connect street', key: 'C', icon: 'connect' },
  { id: 'required', label: 'Toggle required', key: 'R', icon: 'required' },
  { id: 'depot', label: 'Set route start', key: 'S', icon: 'depot' },
  { id: 'delete', label: 'Delete', key: 'X', icon: 'delete' },
];

export function ToolDock() {
  const tool = useWorkspace((s) => s.tool);
  const setTool = useWorkspace((s) => s.setTool);
  const undo = useWorkspace((s) => s.undo);
  const redo = useWorkspace((s) => s.redo);
  const canUndo = useWorkspace((s) => s.history.length > 0);
  const canRedo = useWorkspace((s) => s.future.length > 0);
  return (
    <div className="tool-dock" role="toolbar" aria-label="Editing tools" aria-orientation="vertical">
      {TOOLS.map((t) => (
        <button key={t.id} type="button" className={`tool${tool === t.id ? ' is-active' : ''}`} aria-pressed={tool === t.id} onClick={() => setTool(t.id)} data-tip={`${t.label} (${t.key})`} aria-label={`${t.label} (${t.key})`} data-testid={`tool-${t.id}`}>
          <Icon name={t.icon} size={17} />
        </button>
      ))}
      <span className="tool-dock__sep" aria-hidden="true" />
      <button type="button" className="tool" onClick={undo} disabled={!canUndo} aria-label="Undo (Ctrl+Z)" data-tip="Undo (Ctrl+Z)">
        <Icon name="undo" size={17} />
      </button>
      <button type="button" className="tool" onClick={redo} disabled={!canRedo} aria-label="Redo (Ctrl+Shift+Z)" data-tip="Redo (Ctrl+Shift+Z)">
        <Icon name="redo" size={17} />
      </button>
    </div>
  );
}
