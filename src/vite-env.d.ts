/// <reference types="vite/client" />

declare module '*.toml' {
  const data: Record<string, unknown>;
  export default data;
}
