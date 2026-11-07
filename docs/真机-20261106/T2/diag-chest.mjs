import { Rcon } from "./lib-probe.mjs";
const r = new Rcon(); await r.connect();
console.log("setblock:", await r.cmd("setblock 303 71 300 minecraft:chest replace"));
for (const i of [0,1,2,5,23,26]) {
  const out = await r.cmd(`item replace block 303 71 300 container.${i} with minecraft:dirt 64`);
  console.log(`slot ${i}:`, JSON.stringify(out));
}
console.log("Items[23].count:", await r.cmd("data get block 303 71 300 Items[23].count"));
console.log("Items[0].count:", await r.cmd("data get block 303 71 300 Items[0].count"));
r.close();
