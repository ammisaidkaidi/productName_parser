import { ProductParser } from "../src/index.js";
import { exampleConfig } from "./config.js";

const parser = new ProductParser({ config: exampleConfig, debug: true });

const result = await parser.parse("ROBINET ARRET LAITON MF 1/2 SOMATHERM PRO REF RA12");
console.log(JSON.stringify(result, null, 2));

const batch = await parser.parseBatch([
  "Robinet d'arrêt laiton 1/2 Somatherm Pro RA12",
  "Tube PVC 110 x 3.2 gris",
  "Robinet ABC110",
  "Robinet 1/2"
], { concurrency: 2 });
console.log(JSON.stringify(batch.map((item) => item.data), null, 2));
