import type { ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { Panel } from "@/components/Panel";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { FONTS, SIZES, SKINS, stepSize, type Align, type Layout, type Mode, type Spacing } from "./display";
import { useDisplay } from "./useDisplay";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Font, size and layout only matter while reading. */
  reading: boolean;
}

function Setting({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Choice<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      // Radix reports "" when the pressed item is tapped again; keep the current choice.
      onValueChange={(next) => next && onChange(next as T)}
      aria-label={label}
      className="w-full"
    >
      {options.map(([id, name]) => (
        <ToggleGroupItem key={id} value={id} className="flex-1 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          {name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function DisplaySheet({ open, onOpenChange, reading }: Props) {
  const { display, setDisplay, dark } = useDisplay();

  return (
    <Panel open={open} onOpenChange={onOpenChange} title="Display" description="Appearance, skin, font and layout">
      <Setting title="Appearance">
        <Choice<Mode>
          label="Appearance"
          value={display.mode}
          onChange={(mode) => setDisplay({ mode })}
          options={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
        />
      </Setting>

      <Setting title="Skin">
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Skin">
          {SKINS.map((skin) => {
            const p = dark ? skin.dark : skin.light;
            const on = display.skin === skin.id;
            return (
              <button
                key={skin.id}
                role="radio"
                aria-checked={on}
                onClick={() => setDisplay({ skin: skin.id })}
                className="grid justify-items-center gap-1.5 rounded-lg p-1 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
              >
                <span
                  className={cn(
                    "relative grid h-14 w-full place-items-center rounded-md border font-serif text-lg",
                    on && "ring-2 ring-primary ring-offset-2 ring-offset-card",
                  )}
                  style={{ background: p.paper, color: p.ink, borderColor: p.line }}
                >
                  Aa
                  <i className="absolute right-1.5 bottom-1.5 size-2 rounded-full" style={{ background: p.accent }} />
                </span>
                {skin.name}
              </button>
            );
          })}
        </div>
      </Setting>

      {reading && (
        <>
          <Setting title="Font">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Font">
              {FONTS.map((font) => (
                <Button
                  key={font.id}
                  role="radio"
                  aria-checked={display.font === font.id}
                  variant={display.font === font.id ? "default" : "outline"}
                  style={font.stack ? { fontFamily: font.stack } : undefined}
                  className={cn("h-11 text-base", font.id === "original" && "col-span-2")}
                  onClick={() => setDisplay({ font: font.id })}
                >
                  {font.name}
                </Button>
              ))}
            </div>
          </Setting>

          <Setting title="Text size">
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="Smaller text"
                disabled={display.size <= SIZES[0]}
                onClick={() => setDisplay({ size: stepSize(display.size, -1) })}
              >
                <Minus />
              </Button>
              <output className="flex-1 text-center font-semibold tabular-nums" aria-live="polite">
                {display.size}%
              </output>
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="Larger text"
                disabled={display.size >= SIZES[SIZES.length - 1]!}
                onClick={() => setDisplay({ size: stepSize(display.size, 1) })}
              >
                <Plus />
              </Button>
            </div>
          </Setting>

          <Setting title="Line spacing">
            <Choice<Spacing>
              label="Line spacing"
              value={display.spacing}
              onChange={(spacing) => setDisplay({ spacing })}
              options={[
                ["book", "Book"],
                ["1.3", "1.3"],
                ["1.5", "1.5"],
                ["1.7", "1.7"],
                ["2.0", "2.0"],
              ]}
            />
          </Setting>

          <Setting title="Alignment">
            <Choice<Align>
              label="Alignment"
              value={display.align}
              onChange={(align) => setDisplay({ align })}
              options={[
                ["book", "Book"],
                ["left", "Left"],
                ["justify", "Justified"],
              ]}
            />
          </Setting>

          <Setting title="Layout">
            <Choice<Layout>
              label="Layout"
              value={display.layout}
              onChange={(layout) => setDisplay({ layout })}
              options={[
                ["scroll", "Scroll"],
                ["pages", "Pages"],
              ]}
            />
          </Setting>
        </>
      )}
    </Panel>
  );
}
