// Build-time values Vite compiles into the bundle (apps/admin/Dockerfile sets
// them from the GIT_COMMIT / IMAGE_TAG / BUILD_TIME build args). Unset in dev.
interface ImportMetaEnv {
  readonly VITE_GIT_COMMIT?: string;
  readonly VITE_IMAGE_TAG?: string;
  readonly VITE_BUILD_TIME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
