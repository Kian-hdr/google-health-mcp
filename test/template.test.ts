import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../src/mcp.js";
import { GoogleHealthClient } from "../src/google-health.js";
import { loadTokens, saveTokens, createTokenProvider, oauthFailure, oauthClient, requiredScopes, verifyAndSaveTokens } from "../src/oauth.js";
import { callbackHandler } from "../src/auth.js";

function decode(result: unknown): any {
  assert.ok(result && typeof result === "object" && "content" in result);
  const content = (result as {content: Array<{text:string}>}).content;
  assert.ok(Array.isArray(content));
  return JSON.parse(content[0].text);
}

test("MCP exposes all17 read-only tools without credentials and uses the shared client", async () => {
  const requests: string[] = [];
  const health = new GoogleHealthClient(async () => "synthetic", { fetch: async (url) => {
    requests.push(String(url)); return Response.json({ pairedDevices: [{ id:"synthetic-device" }] });
  }});
  const server = createServer(health); const client = new Client({name:"synthetic",version:"1"});
  const [left,right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left),client.connect(right)]);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length,17);
    assert.ok(tools.every(t=>t.annotations?.readOnlyHint===true && t.annotations?.destructiveHint===false));
    assert.equal(decode(await client.callTool({name:"get_data_source_info",arguments:{}})).transport,"stdio");
    assert.equal(requests.length,0);
    assert.equal(decode(await client.callTool({name:"get_devices",arguments:{}})).pairedDevices[0].id,"synthetic-device");
    assert.equal(new URL(requests[0]).pathname,"/v4/users/me/pairedDevices");
  } finally { await client.close(); await server.close(); }
});

test("stdio discovery works with no account setup and missing credentials stay actionable", async () => {
  const root=await mkdtemp(join(tmpdir(),"health-stdio-"));
  const client=new Client({name:"synthetic-stdio",version:"1"});
  const transport=new StdioClientTransport({command:process.execPath,args:["dist/src/index.js"],env:{PATH:process.env.PATH??"",GOOGLE_HEALTH_TOKEN_PATH:join(root,"missing.json"),GOOGLE_CLIENT_ID:"",GOOGLE_CLIENT_SECRET:""},stderr:"pipe"});
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length,17);
    const result=await client.callTool({name:"get_devices",arguments:{}});
    assert.equal(result.isError,true);
    assert.match(JSON.stringify(result),/CONNECT_GOOGLE_REQUIRED/);
  } finally { await client.close(); await rm(root,{recursive:true,force:true}); }
});

test("OAuth files are atomic/private and reject malformed content and symlinks", async () => {
  const root=await mkdtemp(join(tmpdir(),"health-oauth-"));const path=join(root,"tokens.json");
  try {
    assert.equal(await loadTokens(path),undefined);
    await saveTokens({access_token:"synthetic",refresh_token:"synthetic-refresh"},path);
    assert.equal((await loadTokens(path))?.refresh_token,"synthetic-refresh");
    if(process.platform!=="win32")assert.equal((await stat(path)).mode&0o777,0o600);
    await writeFile(path,"malformed synthetic content");
    await assert.rejects(loadTokens(path),(e:any)=>e.code==="SETUP_REQUIRED" && !e.message.includes(root));
    await rm(path);await symlink(join(root,"target.json"),path);
    await assert.rejects(saveTokens({access_token:"synthetic"},path));
  } finally {await rm(root,{recursive:true,force:true});}
});

test("OAuth failures distinguish network, revoked grants and configuration without leaking details",()=>{
  assert.equal(oauthFailure({code:"ENOTFOUND",message:"synthetic-secret"}).code,"GOOGLE_NETWORK_UNAVAILABLE");
  assert.equal(oauthFailure({response:{data:{error:"invalid_grant"}}}).code,"RECONNECT_REQUIRED");
  assert.equal(oauthFailure({response:{data:{error:"invalid_client"}}}).code,"GOOGLE_CLIENT_CONFIGURATION_ERROR");
  assert.equal(oauthFailure({response:{status:429}}).code,"GOOGLE_HTTP_429");
  assert.equal(oauthFailure(new Error("synthetic-secret")).code,"TOKEN_PROVIDER_ERROR");
  const url=oauthClient({GOOGLE_CLIENT_ID:"synthetic-id",GOOGLE_CLIENT_SECRET:"synthetic-secret"}).generateAuthUrl({scope:requiredScopes()});
  assert.ok(!url.includes("synthetic-secret"));assert.ok(requiredScopes().every(s=>s.endsWith(".readonly")));
});

test("loopback callback rejects bad state/host, exchanges once, and redacts provider failures",async()=>{
  let exchanged=0,finished=0;const server=httpServer();
  server.on("request",callbackHandler("synthetic-state",async code=>{assert.equal(code,"synthetic-code");exchanged++;throw new Error("synthetic-secret");},()=>finished++));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as {port:number}).port;const base=`http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base+"/oauth/callback?state=wrong&code=synthetic-code")).status,400);
    const badHost = await new Promise<number>((resolve,reject)=>{
      const request=httpRequest(base+"/oauth/callback?state=synthetic-state&code=synthetic-code",{headers:{Host:"unexpected.example"}},response=>{response.resume();resolve(response.statusCode??0);});
      request.on("error",reject);request.end();
    });
    assert.equal(badHost,400);
    assert.equal(exchanged,0);
    const response=await fetch(base+"/oauth/callback?state=synthetic-state&code=synthetic-code");
    assert.equal(response.status,400);assert.doesNotMatch(await response.text(),/synthetic-secret/);
    assert.equal((await fetch(base+"/oauth/callback?state=synthetic-state&code=synthetic-code")).status,400);
    assert.equal(exchanged,1);assert.equal(finished,1);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("missing local token never starts provider authentication",async()=>{
  const root=await mkdtemp(join(tmpdir(),"health-missing-"));
  try {await assert.rejects(createTokenProvider({GOOGLE_HEALTH_TOKEN_PATH:join(root,"missing.json")})(),(e:any)=>e.code==="CONNECT_GOOGLE_REQUIRED");}
  finally {await rm(root,{recursive:true,force:true});}
});


test("account linkage is verified before tokens are persisted", async()=>{
  const root=await mkdtemp(join(tmpdir(),"health-linkage-"));const path=join(root,"tokens.json");
  try {
    await assert.rejects(verifyAndSaveTokens({access_token:"synthetic"},path,async()=>Response.json({error:{message:"ACCOUNT_NOT_LINKED"}},{status:400})),(e:any)=>e.code==="ACCOUNT_NOT_LINKED");
    assert.equal(await loadTokens(path),undefined);
    let calls=0;
    await verifyAndSaveTokens({access_token:"synthetic",refresh_token:"synthetic-refresh"},path,async url=>{calls++;assert.equal(new URL(String(url)).pathname,"/v4/users/me/identity");return Response.json({syntheticLinked:true});});
    assert.equal(calls,1);assert.equal((await loadTokens(path))?.access_token,"synthetic");
    assert.ok(!(await readFile(path,"utf8")).includes("syntheticLinked"));
  } finally {await rm(root,{recursive:true,force:true});}
});

test("newly authorized token is usable after an earlier missing-connection result",async()=>{
  const root=await mkdtemp(join(tmpdir(),"health-new-authorization-"));const path=join(root,"tokens.json");
  const provider=createTokenProvider({GOOGLE_HEALTH_TOKEN_PATH:path,GOOGLE_CLIENT_ID:"synthetic-id",GOOGLE_CLIENT_SECRET:"synthetic-secret"});
  try {
    await assert.rejects(provider(),(e:any)=>e.code==="CONNECT_GOOGLE_REQUIRED");
    await saveTokens({access_token:"synthetic-current",expiry_date:Date.now()+3_600_000},path);
    assert.equal(await provider(),"synthetic-current");
  } finally {await rm(root,{recursive:true,force:true});}
});
