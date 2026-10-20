import { fileURLToPath } from "node:url";
import { validatePublicData } from "./public-data.mjs";

const result = await validatePublicData(fileURLToPath(new URL("../public/", import.meta.url)), fileURLToPath(new URL("./public-data-manifest.json", import.meta.url)));
console.log("已核验固定公开数据及姓名披露范围：", JSON.stringify(result));
