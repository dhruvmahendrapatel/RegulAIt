import { describe, expect, it, vi, beforeEach } from "vitest";
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock("../../../api/client",()=>({api:{get:mocks.get,postWithHeaders:mocks.post}}));
vi.mock("../../../stepup/stepUp",()=>({withStepUp:(fn:(headers:Record<string,string>)=>unknown)=>fn({"x-regulait-step-up":"synthetic-grant"})}));
import { bomMetadataApi } from "./bomApi";
const id="00000000-0000-4000-8000-000000000001",subject={kind:"agent" as const,id};
const created={id,version:1,serialNumber:`urn:uuid:${id}`,bodySha256:"a".repeat(64)};
beforeEach(()=>vi.clearAllMocks());
describe("published B3 browser adapter",()=>{
 it("uses exact snapshot-list path and validates released flag",async()=>{mocks.get.mockResolvedValue({subject,released:false,snapshots:[]});expect((await bomMetadataApi.list(subject)).released).toBe(false);expect(mocks.get).toHaveBeenCalledWith(`/v1/ai-bom/agent/${id}/snapshots`);mocks.get.mockResolvedValue({subject,snapshots:[]});await expect(bomMetadataApi.list(subject)).rejects.toThrow();});
 it("captures creation path and validates success before reporting evidence",async()=>{mocks.post.mockResolvedValue({body:created});await bomMetadataApi.create(subject);expect(mocks.post).toHaveBeenCalledWith(`/v1/ai-bom/agent/${id}/snapshots`,{},{"x-regulait-step-up":"synthetic-grant"});mocks.post.mockResolvedValue({body:{}});await expect(bomMetadataApi.create(subject)).rejects.toThrow();});
 it("refuses invalid subject before any request",async()=>{await expect(bomMetadataApi.create({...subject,id:"../other"})).rejects.toThrow();expect(mocks.post).not.toHaveBeenCalled();});
});
