# Grafted legacy build assets — safe to delete after ~2026-07-09

These are the byte-exact asset files of the 2026-07-02 production build (`eab0e67`,
fetched from the live deployment). They ride along in `public/` so the NEXT deploys
still serve them: Discord's activity proxy pins the entry HTML per POP for hours
(ignoring `no-store`), and a pinned copy of the old HTML requests exactly these
pre-skew-protection URLs. While these files exist in every deployment, that stale
HTML keeps launching the old app version instead of 404ing — which is what caused
the 2026-07-02 launch outage (see deploy-asset-skew).

Once every proxy cache has turned over to a `?dpl=`-tagged HTML document (give it
a week), these files serve nobody and the whole directory can be deleted.
