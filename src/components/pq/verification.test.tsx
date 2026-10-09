import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VerificationView } from "@/routes/verify";
afterEach(cleanup);
describe("verification status rendering",()=>{
  it("never presents offline signatures alone as a verified launch",()=>{
    render(<VerificationView result={{checks:[{id:"canonical",label:"Canonical payload",status:"pass",detail:"valid"},{id:"signature",label:"ML-DSA-65 signature",status:"pass",detail:"valid"}],passport:null}}/>);
    expect(screen.getByRole("status")).toHaveTextContent("Partial verification");
  });
  it("keeps RPC unavailability separate from an invalid signature",()=>{
    render(<VerificationView result={{checks:[{id:"signature",label:"ML-DSA-65 signature",status:"pass",detail:"valid"},{id:"anchor",label:"Anchor",status:"unavailable",detail:"RPC unavailable"}],passport:null}}/>);
    expect(screen.getByRole("status")).toHaveTextContent("Partial verification");expect(screen.getByText("RPC unavailable")).toBeInTheDocument();
  });
  it("shows failure when any proof fails, even with all other checks passing",()=>{
    const ids=["canonical","signature","registration","anchor","terms","record","transaction","onchain","metadata","lifecycle"];
    render(<VerificationView result={{checks:ids.map(id=>({id,label:id,status:id==="terms"?"fail":"pass",detail:id==="terms"?"fees altered":"valid"})),passport:null}}/>);
    expect(screen.getByRole("status")).toHaveTextContent("Verification failed");
  });
  it("requires every independent proof before showing a verified on-chain launch",()=>{
    const ids=["canonical","signature","registration","anchor","terms","record","transaction","onchain","metadata","lifecycle"];
    render(<VerificationView result={{checks:ids.map(id=>({id,label:id,status:"pass",detail:"valid"})),passport:null}}/>);
    expect(screen.getByRole("status")).toHaveTextContent("on-chain launch verified");
  });
});
