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
