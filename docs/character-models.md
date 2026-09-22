# Character models

The game builds its figures procedurally so it runs on a fresh clone with no assets. A rigged glTF
model at `apps/client/public/models/soldier.glb` replaces them automatically when present.

## Attribution

Models used in this project and their required credits. **CC-BY models must be credited in the
game's own credits screen**, not only here.

### S.W.A.T. Operator

- Author: SpatialNeglect (jeandiz)
- Licence: **CC-BY 4.0** — attribution required
- Source: https://sketchfab.com/3d-models/swat-operator-9e82fabf26194896b5ad4a364d864eab
- Newer version: https://skfb.ly/oATOX
- Rigged with Mixamo, animated. 106.7k triangles, 55.8k vertices as published.
- Includes an M4 carbine by bobeer (CC-BY): https://skfb.ly/6TsXs
- Clothing and tactical pieces by ErhanMatur, Bzovius, SrGeneroso, shedmon, Albin, Mayess.

Required credit line:

```
"S.W.A.T. Operator" by SpatialNeglect, licensed CC-BY 4.0.
M4 carbine by bobeer, licensed CC-BY 4.0.
```

### Soldier (fallback, fetched by tools/fetch-models.mjs)

- Author: Quaternius
- Licence: CC-BY 3.0
- Source: https://poly.pizza/m/oAArCNHjFB

## Adding a model

1. Download in **glTF** format. Not FBX: glTF carries mesh, skeleton, materials and animations in one
   file, which is what the loader reads.
2. **Optimise it.** This step is not optional for a realistic model.
3. Save as `apps/client/public/models/soldier.glb`.
4. Restart the dev server.

## Why optimisation matters here

A published realistic character is built for a cinematic, not for eight of them on a phone:

- **Triangles.** An arena figure needs 4k to 8k. A published model often ships 100k+. At eight alive
  that is the difference between 800k triangles and 8k, and a mobile GPU feels it.
- **Textures.** 4K PBR maps are 16x the memory of 1K, and at arena distance the difference is not
  visible. 1K is generous; 512 is usually enough.
- **File size.** Content hosting is Cloudflare Workers Static Assets on the free tier, capped at
  25 MB per file. A 15 MB character also costs the player that download before they can play.

Use https://app.cinevva.com/tools/glb-optimizer with Draco compression enabled, or `gltf-transform`
locally:

```sh
npx @gltf-transform/cli optimize input.glb soldier.glb --texture-size 1024 --simplify-error 0.001
```

Target: **under 3 MB, under 15k triangles.** Check the console on load; the loader logs mesh count,
clip names and measured height.

## Animation clip names

The loader matches clips by case-insensitive substring, looking for `idle`, `walk`, `run`, `aim`,
`shoot`, `death` and `hit` anywhere in a clip's name. That covers the usual variants (`Idle`,
`Armature|Idle`, `CharacterArmature|Idle`, `Rifle Idle`).

Clip names are logged on load. A model that animates wrong is almost always a naming mismatch, and
the log shows exactly what the file contains.

## Adding rifle animations to a Mixamo-rigged model

A model tagged `mixamo` uses Mixamo's bone names, so Mixamo's own clips retarget onto it:

1. Upload the model to https://www.mixamo.com/
2. Search "rifle" and apply: Rifle Idle, Rifle Walk, Rifle Run, Firing Rifle, Reloading, Death From
   Front.
3. Download **With Skin** for the first clip and **Without Skin** for the rest, so you get one mesh
   rather than six.
4. Combine in Blender, export glTF, optimise.

This is the only free route to real weapon animations. Every CC0 character pack ships melee clips.
