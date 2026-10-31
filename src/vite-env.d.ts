/// <reference types="vite/client" />

/** The build players must share to play together: the commit it was built from, or 'dev'. */
declare const __TRENCHLINE_BUILD__: string;

interface ImportMetaEnv {
  /** Where the rooms' relay is (server/): the deployed Worker's address. */
  readonly VITE_RELAY_URL?: string;
}

declare module '*.toml' {
  const data: Record<string, unknown>;
  export default data;
}

declare module '*.wgsl' {
  const source: string;
  export default source;
}
