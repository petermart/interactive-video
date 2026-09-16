/**
 * Writes image prompts for the new locations, reusing the existing plates' style preamble verbatim.
 *
 * The preamble is copied from a known-good plate rather than retyped, so the new plates cannot drift from
 * the house style by a stray word: 21 of the existing 22 share it exactly, and these join them.
 *
 *   bun scripts/write-environment-prompts.ts
 */

const DIR = "common-generated-assets/environments";
/** Any plate carrying the shared preamble; utility-tunnels is one of the 21. */
const preamble = (await Bun.file(`${DIR}/utility-tunnels.txt`).text()).split("\n")[0]!;

const BODIES: Record<string, string> = {
  chapel: `ENVIRONMENT: Prison chapel.
Narrow chapel with rows of worn wooden pews facing a plain lectern, tall dusty stained glass throwing coloured
light across the floor, a padlocked wooden organ loft on a balcony above the entrance, iron radiators, a scuffed
tile aisle. Quiet and still, dust visible in the window light.
Traversable paths to show: main double doors to the corridor, a low side passage to the library, a narrow vestry
door, and the padlocked ladder up to the organ loft.`,

  "boiler-room": `ENVIRONMENT: Prison boiler room.
Cramped industrial plant room with two large riveted furnaces glowing at their firing doors, an iron catwalk and
stair running above, a dense tangle of lagged pipes and pressure gauges, a coal-dust floor, and a square ash chute
hatch set into the far wall. Heat haze distorting the air, deep shadow between the boilers.
Traversable paths to show: a catwalk stair down from a tunnel hatch, a heavy service door, a pipe gallery opening,
and the ash chute hatch in the outer wall.`,

  "motor-pool": `ENVIRONMENT: Prison motor pool.
Vehicle maintenance bay with two white prison transport vans parked over open inspection pits, a prison bus at the
rear, stacked fuel drums, a trolley jack and engine hoist, tool boards and hanging air lines, oil-stained concrete.
A large corrugated roll-up door stands partly open at the far end onto a road.
Traversable paths to show: the roll-up door to the outside road, a bay door to the loading dock, a side gate to the
yard, and the open inspection pits beneath the vans.`,

  "records-room": `ENVIRONMENT: Prison records room.
Administrative archive with grey filing cabinets stacked to the ceiling, a worktable with unrolled building
blueprints under a desk lamp, a wall-mounted key cabinet behind wired glass, rolling ladder on a rail, carpet
tiles, a rotary telephone. Warmer and more orderly than the rest of the prison.
Traversable paths to show: a connecting door to the warden's office, a main corridor door, and a narrow vestry
passage.`,

  morgue: `ENVIRONMENT: Prison morgue.
Cold tiled examination room with a bank of steel refrigerated drawers along one wall, a wheeled gurney in the
centre carrying a zipped body bag with a paper tag, a scrub sink, a clipboard on a hook, and a floor hatch with a
recessed ring pull. Clinical, blue-tinged and very still.
Traversable paths to show: double doors to the infirmary, a floor hatch down to the utility tunnels, and a
collection corridor leading to the loading dock.`,
};

for (const [id, body] of Object.entries(BODIES)) {
  const file = `${DIR}/${id}.txt`;
  await Bun.write(file, `${preamble}\n\n${body}\n`);
  console.log(`wrote ${file}`);
}
