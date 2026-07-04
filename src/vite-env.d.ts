/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISCORD_CLIENT_ID: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  // Optional: large image for the Rich Presence card. A public image URL (Discord
  // fetches it server-side) or an uploaded Art Asset key. Defaults to the icon
  // served from public/connections-icon.png on the production host.
  readonly VITE_RP_ICON_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Set by the inline self-healing boot script in index.html and cleared/read by src/main.tsx.
// __appMounted flips true once React's render() runs; __cxBootMounted disarms the white-screen
// watchdog and clears the one-shot reload guard.
interface Window {
  __appMounted?: boolean;
  __cxBootMounted?: () => void;
  __cxRetried?: boolean;
  /** Build/deployment id stamped into index.html at build time (beacon `b=` tag). */
  __cxBuild?: string;
}
