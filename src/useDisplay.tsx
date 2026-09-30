import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyChrome, loadDisplay, palette, saveDisplay, type Display, type Palette } from "./display";

interface DisplayState {
  display: Display;
  setDisplay: (patch: Partial<Display>) => void;
  /** The resolved scheme: the Appearance setting, or the system's when set to System. */
  dark: boolean;
  palette: Palette;
}

const Context = createContext<DisplayState | null>(null);

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)");

export function DisplayProvider({ children }: { children: ReactNode }) {
  const [display, setState] = useState(loadDisplay);
  const [system, setSystem] = useState(() => systemDark().matches);

  useEffect(() => {
    const query = systemDark();
    const change = () => setSystem(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  const dark = display.mode === "system" ? system : display.mode === "dark";
  const colors = palette(display, dark);
  useEffect(() => applyChrome(colors, dark), [colors, dark]);

  const value = useMemo<DisplayState>(
    () => ({
      display,
      dark,
      palette: colors,
      setDisplay: (patch) =>
        setState((current) => {
          const next = { ...current, ...patch };
          saveDisplay(next);
          return next;
        }),
    }),
    [display, dark, colors],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDisplay(): DisplayState {
  const state = useContext(Context);
  if (!state) throw new Error("useDisplay needs a DisplayProvider");
  return state;
}
