/**
 * Adds the new locations to data/world.json, wiring their neighbours in BOTH directions.
 *
 * The graph is not implied to be symmetric anywhere in the code: a step moves to a random entry of the
 * current location's `neighbors`, and the LLM only ever sees the list as written. So a new location that
 * is not named by its neighbours is reachable one way only and would become a dead end.
 *
 * Idempotent: re-running changes nothing once the entries exist.
 *
 *   bun scripts/add-environments.ts
 */

type Env = { id: string; description: string; neighbors: string[]; image: string | null };

const NEW: Env[] = [
  {
    id: "chapel",
    description: "Prison chapel, worn pews, dusty stained glass, a padlocked organ loft above.",
    neighbors: ["hall-main", "library", "records-room"],
    image: "common-generated-assets/environments/chapel.png",
  },
  {
    id: "boiler-room",
    description: "Boiler room, twin furnaces, iron catwalks, an ash chute in the far wall. Heat haze.",
    neighbors: ["utility-tunnels", "laundry", "workshop"],
    image: "common-generated-assets/environments/boiler-room.png",
  },
  {
    id: "motor-pool",
    description: "Prison motor pool, transport vans over inspection pits, fuel drums, roll-up door to the yard road. Exit candidate.",
    neighbors: ["loading-dock", "yard", "workshop"],
    image: "common-generated-assets/environments/motor-pool.png",
  },
  {
    id: "records-room",
    description: "Records room, filing cabinets to the ceiling, prison blueprints, a key cabinet behind wired glass.",
    neighbors: ["warden-office", "hall-main", "chapel"],
    image: "common-generated-assets/environments/records-room.png",
  },
  {
    id: "morgue",
    description: "Prison morgue, steel drawers, a gurney, a zipped body bag tagged for collection.",
    neighbors: ["infirmary", "utility-tunnels", "loading-dock"],
    image: "common-generated-assets/environments/morgue.png",
  },
];

/** Vehicles genuinely leave the grounds, so the motor pool earns exit status; the morgue only leads to one. */
const NEW_EXITS = ["motor-pool"];

const path = "data/world.json";
const world = await Bun.file(path).json();

for (const env of NEW) {
  if (world.environments.some((e: Env) => e.id === env.id)) {
    console.log(`skip ${env.id} (already present)`);
    continue;
  }
  world.environments.push(env);
  console.log(`added ${env.id}`);
}

// Back-links, so every new location can be walked out of as well as into.
let linked = 0;
for (const env of NEW) {
  for (const neighborId of env.neighbors) {
    const neighbor = world.environments.find((e: Env) => e.id === neighborId);
    if (!neighbor) {
      console.warn(`  WARNING: ${env.id} names unknown neighbour ${neighborId}`);
      continue;
    }
    if (!neighbor.neighbors.includes(env.id)) {
      neighbor.neighbors.push(env.id);
      linked++;
    }
  }
}
console.log(`added ${linked} back-links`);

for (const id of NEW_EXITS) {
  if (!world.exitEnvironments.includes(id)) {
    world.exitEnvironments.push(id);
    console.log(`added exit ${id}`);
  }
}

await Bun.write(path, `${JSON.stringify(world, null, 2)}\n`);

// A location nothing points at is unreachable; a location pointing nowhere traps the player.
const ids = new Set(world.environments.map((e: Env) => e.id));
for (const e of world.environments as Env[]) {
  const bad = e.neighbors.filter(n => !ids.has(n));
  if (bad.length) console.error(`BROKEN: ${e.id} -> ${bad.join(", ")}`);
  if (!e.neighbors.length) console.error(`DEAD END: ${e.id} has no neighbours`);
  if (![...world.environments].some((o: Env) => o.neighbors.includes(e.id))) {
    console.error(`UNREACHABLE: nothing leads to ${e.id}`);
  }
}
console.log(`\n${world.environments.length} environments, exits: ${world.exitEnvironments.join(", ")}`);
