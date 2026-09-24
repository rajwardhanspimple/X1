# Built-in arenas

Choose **Choose arena** from the main menu, select a map, then select **Start round**.
The selection is saved for the next visit. The leaderboard uses the same map list.
All three maps use the existing three-minute Survival mode.

| Arena | Size (world units) | Content revision | Layout |
| --- | --- | --- | --- |
| Container Yard | 64 x 64 | `container-yard-01` | Existing containers, central corridor and stacks |
| Military Outpost | 112 x 112 | `military-outpost-01` | Four walk-through bunkers, sandbags, supplies and two watchtowers |
| Urban Street | 128 x 128 | `urban-street-01` | Eight solid building blocks, cross alleys, car cover and two rear lookout decks |

Urban buildings are solid cover, not enterable rooms. The outpost bunkers have two opposing entrances.
The new lookout stairs have 0.25-unit risers and can be walked up without jumping.
Decorative seams, windows and trim do not add collision.

## Shared map data

`packages/sim/src/maps.ts` owns the catalogue, spawn points and brush dimensions.
The renderer draws these brushes; `createArenaContent` builds the collision world from them.
The verifier uses `resolveArenaContent` to validate map ID, mode and content revision before replay.
Unknown maps and wrong revisions are rejected instead of using Container Yard geometry.

Container Yard reuses its original layout functions. Its collision, spawns and simulation rules
are unchanged, so `SIM_VERSION` remains 7. New maps use separate IDs and content revisions.
If a published map's geometry or spawns change, give that map a new content revision.

Map switching retains the Babylon scene and camera. Map-owned geometry is replaced, old worker
state is disposed, and enemies, effects and camera offsets are reset before the new round.

## Deploy before submitting new-map runs

The running verifier must receive the new catalogue before a new-map round is submitted.
From the updated repository, while logged in to the linked Supabase project:

```sh
pnpm functions:bundle
npx supabase@latest functions deploy verify-run-bundled --project-ref nprfxnegcwqqpjasoxln --no-verify-jwt
```

Keep `VERIFIER_WEBHOOK_SECRET` unchanged. The function authenticates the database trigger and
slice chaining with this header. There is no database migration for the map catalogue.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm functions:bundle
pnpm --filter @rearena/client build
pnpm --filter @rearena/e2e exec playwright test tests/maps.spec.ts
```

The map tests check spawn body clearance, dimensions, stair access, full-round replay and two-slice
replay. Renderer tests check map switching retains the scene/camera and disposes old map meshes.
Browser tests check persisted selection and the selected map's configuration sent to the real worker.

For a manual check, play each arena, climb both lookout decks, try the bunker entrances and cross
alleys, then switch back to Container Yard. Complete one round on each new arena after redeploying
the verifier and check for **Verified** and the separate map leaderboard.

## Current limits

Enemy AI still uses direct pursuit. It can stall at complex obstacles or below elevated players;
NavGraph routing and tactical cover behaviour belong to WO-54. These maps do not add that AI work.
The content-manifest publication pipeline and the other weapon/content items in WO-15 remain separate work.
