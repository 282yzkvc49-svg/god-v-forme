// Упрощённые типы React для локальной проверки без сети (npm недоступен в среде сборки).
// В GitHub Actions используется настоящий @types/react (npm run typecheck).
declare module 'react' {
  export type ReactNode = any;
  export type FC<P = {}> = (props: P & { children?: ReactNode }) => any;
  export type CSSProperties = Record<string, any>;
  export interface SVGAttributes<T> { [k: string]: any }
  export interface HTMLAttributes<T> { [k: string]: any }
  export type ReactElement = any;
  export type Context<T> = any;
  export namespace JSX { type Element = any }
  export type Dispatch<A> = (value: A) => void;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export interface MutableRefObject<T> { current: T }
  export interface RefObject<T> { readonly current: T | null }
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly any[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly any[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly any[]): T;
  export function useCallback<T extends (...args: any[]) => any>(cb: T, deps: readonly any[]): T;
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export function useRef<T>(initial: T | null): RefObject<T>;
  export function useRef<T = undefined>(): MutableRefObject<T | undefined>;
  export function useId(): string;
  export function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, get: () => T, getServer?: () => T): T;
  export function createContext<T>(v: T): any;
  export function useContext<T>(ctx: any): T;
  export function memo<T>(c: T): T;
  export const Fragment: any;
  export const StrictMode: any;
  export class Component<P = {}, S = {}> { props: P; state: S; setState(s: Partial<S>): void; constructor(p: P) }
  const React: any;
  export default React;
}
declare module 'react/jsx-runtime' { export const jsx: any; export const jsxs: any; export const Fragment: any }
declare module 'react-dom/client' { export function createRoot(el: Element): { render(n: any): void } }
declare module 'react-dom' { export function createPortal(n: any, el: Element): any }
declare namespace JSX {
  interface IntrinsicElements { [el: string]: any }
  interface Element {}
  interface ElementChildrenAttribute { children: {} }
  type IntrinsicAttributes = { key?: any };
}
