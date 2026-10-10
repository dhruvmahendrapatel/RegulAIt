import {expect,it} from "vitest";
import {BATCH4_SETTING_COPY,BATCH4_STRICT_DEFAULTS,batch4SettingRelaxed} from "./monitorThresholds";
it("monitor threshold copy/defaults and direction match the gateway contract",async()=>{
 const shared=await import(new URL("../../../../../../packages/shared/src/batch4.ts",import.meta.url).pathname);
 for(const key of Object.keys(BATCH4_STRICT_DEFAULTS) as (keyof typeof BATCH4_STRICT_DEFAULTS)[]){
  expect(BATCH4_SETTING_COPY[key]).toEqual(shared.BATCH4_SETTING_COPY[key]);expect(BATCH4_STRICT_DEFAULTS[key]).toBe(shared.BATCH4_STRICT_DEFAULTS[key]);
  for(const value of [1,3,14,24,90,100,168])expect(batch4SettingRelaxed(key,value)).toBe(shared.batch4SettingRelaxed(key,value));
 }
});
