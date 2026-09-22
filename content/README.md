# Content

Source content for RE:Arena. Everything here is data; nothing here is code.

```
maps/<slug>/       source glTF, meta.json (MapMeta), collision-tagged nodes
weapons/<slug>.json   WeaponDef
modes/<slug>.json     ModeRules
enemies/<slug>.json   EnemyArchetype
medals/<slug>.json    MedalDef
levels.json           LevelThresholds
credits.json          Licence and attribution for every third-party asset (CC0, CC-BY-4.0, or owned)
```

Run `pnpm content:check` before opening a pull request. Gameplay-affecting data (modes, weapons, enemies, collision, spawn points) is hashed into `SimContent.hash`; changing rules also requires a `simVersion` bump in `packages/sim`.
