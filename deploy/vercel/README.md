# Vercel config for the static build

`vercel.json` here is the config of the Vercel project "sweep" (https://sweep-ashy.vercel.app). It serves `apps/web/dist-static` with the same security headers as the Node server (`apps/server/src/app.ts`): the same Content-Security-Policy, with the same eight OpenStreetMap service hosts, plus `nosniff`, `same-origin` referrers and `DENY` framing. Keep the host list in step with `MAP_HOSTS` in `apps/server/src/app.ts`.

Deploy (from a machine whose Vercel CLI is logged in to the project's team):

```bash
pnpm build:static
mkdir -p /tmp/sweep-vercel && cp -r apps/web/dist-static/. deploy/vercel/vercel.json /tmp/sweep-vercel/
cd /tmp/sweep-vercel && npx vercel@64.5.0 link --project sweep --yes && npx vercel@64.5.0 deploy --prod --yes
```

GitHub Pages (`.github/workflows/pages.yml`) cannot set response headers, so the Pages copy runs without this CSP.
