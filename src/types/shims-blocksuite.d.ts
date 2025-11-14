// Minimal shims to avoid TypeScript resolving ESM TS sources from @blocksuite/* during CJS builds
declare module '@blocksuite/store' {
  const anyExport: any;
  export = anyExport;
}

declare module '@blocksuite/store/test' {
  const anyExport: any;
  export = anyExport;
}

declare module '@blocksuite/blocks' {
  const anyExport: any;
  export = anyExport;
}
