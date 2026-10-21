/// <reference types="vite/client" />

declare module '*.toml' {
  const data: Record<string, unknown>;
  export default data;
}

declare module '*.wgsl' {
  const source: string;
  export default source;
}
