import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./env";
import { handleMcp } from "./mcp";
import { handleWeb } from "./web";

const apiHandler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return handleMcp(req, env, (ctx as ExecutionContext & { props: Props }).props);
  },
};

const defaultHandler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return handleWeb(req, env, ctx);
  },
};

// The protected-resource metadata must name this deployment's own URL, which isn't known until
// it's deployed (workers.dev subdomain or a custom domain), so build one provider per origin.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["mail", "offline_access"],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Mailroom" },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return providerFor(new URL(req.url).origin).fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
