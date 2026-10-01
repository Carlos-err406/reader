import { useEffect, useState } from "react";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** The name to start from when renaming. */
  initial?: string;
  confirm: string;
  /** Resolves when saved; a rejection's message is shown and the sheet stays open. */
  onSave: (name: string) => Promise<void>;
}

/** Asks for a short name, such as a collection's, in a sheet with the keyboard ready. */
export function NameSheet({ open, onOpenChange, title, description, initial = "", confirm, onSave }: Props) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(initial);
    setError(undefined);
  }, [open, initial]);
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave(name);
      onOpenChange(false);
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel open={open} onOpenChange={onOpenChange} title={title} description={description} focusField>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="text-sm text-muted-foreground">{description}</p>
        <input
          autoFocus
          value={name}
          maxLength={80}
          enterKeyHint="done"
          onChange={(e) => setName(e.target.value)}
          aria-label="Name"
          placeholder="Name"
          className="h-11 rounded-lg border bg-background px-3 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !name.trim()}>
            {confirm}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
