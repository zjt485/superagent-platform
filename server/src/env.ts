/**
 * Loads `.env` for local runs without overriding real environment variables.
 * Docker injects configuration directly, so this is a no-op there.
 */
export function loadLocalEnv(): void {
  for (const file of ['.env', '../.env']) {
    try {
      process.loadEnvFile(file)
    } catch {
      // File is optional.
    }
  }
}
