import fs from "node:fs";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import slsHttp from "serverless-http";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
// @ts-ignore
import NextServer from "next/dist/server/next-server.js";
import { loadConfig } from "./util.js";
import { debug } from "./logger.js";

setNextjsServerWorkingDirectory();
const nextDir = path.join(__dirname, ".next");
const config = loadConfig(nextDir);
const htmlPages = loadHtmlPages();
debug({ nextDir });

// Create a NextServer
const requestHandler = new NextServer.default({
  // Next.js compression should be disabled because of a bug in the bundled
  // `compression` package — https://github.com/vercel/next.js/issues/11669
  conf: { ...config, compress: false },
  customServer: false,
  dev: false,
  dir: __dirname,
  // "minimalMode" controls:
  //  - Rewrites and redirects
  //  - Headers
  //  - Middleware
  //  - SSG cache
  minimalMode: false,
}).getRequestHandler();

// Create a HTTP server invoking the NextServer
const server = slsHttp(
  async (req: IncomingMessage, res: ServerResponse) => {
    if (process.env.OPEN_NEXT_REQ_BASE_URL) {
      //   // https://google.com + /nextjs/route
      req.url = `${process.env.OPEN_NEXT_REQ_BASE_URL}${req.url}`;
    }

    await requestHandler(req, res).catch((e: any) => {
      console.error("NextJS request failed.");
      console.error(e);

      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          {
            message: "Server failed to respond.",
            details: e,
          },
          null,
          2
        )
      );
    });
  },
  {
    binary: true,
    provider: "aws",
    request: (request: any) => {
      // nextjs doesn't parse body if the property exists
      // https://github.com/dougmoscrop/serverless-http/issues/227
      delete request.body;
    },
  }
);

/////////////
// Handler //
/////////////

export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context
): Promise<APIGatewayProxyResultV2> {
  debug(event);

  // WORKAROUND: Pass headers from middleware function to server function (AWS specific) — https://github.com/serverless-stack/open-next#workaround-pass-headers-from-middleware-function-to-server-function-aws-specific
  const middlewareRequestHeaders = JSON.parse(
    event.headers["x-op-middleware-request-headers"] || "{}"
  );
  event.headers = { ...event.headers, ...middlewareRequestHeaders };

  // Invoke NextServer
  const response: APIGatewayProxyResultV2 = await server(event, context);

  // WORKAROUND: `NextServer` does not set cache response headers for HTML pages — https://github.com/serverless-stack/open-next#workaround-nextserver-does-not-set-cache-response-headers-for-html-pages
  if (
    htmlPages.includes(event.rawPath) &&
    !response.headers?.["cache-control"]
  ) {
    response.headers!["cache-control"] =
      "public, max-age=0, s-maxage=31536000, must-revalidate";
  }

  // WORKAROUND: Pass headers from middleware function to server function (AWS specific) — https://github.com/serverless-stack/open-next#workaround-pass-headers-from-middleware-function-to-server-function-aws-specific
  const middlewareResponseHeaders = JSON.parse(
    event.headers["x-op-middleware-response-headers"] || "{}"
  );
  response.headers = { ...response.headers, ...middlewareResponseHeaders };

  // my workaround for setting headers with same name
  if (
    "overrideCookies" in global &&
    global.overrideCookies &&
    typeof global.overrideCookies === "object" &&
    Array.isArray(global.overrideCookies)
  ) {
    response.cookies = global.overrideCookies || [];

    console.log("overrideHeaders set and cleared");
    global.overrideCookies = [];
  }

  console.log("response.headers", response.headers);
  console.log("response.cookies", response.cookies);

  // new beta appDir does not set statusCode and lambda fails to correctly send response
  if (!response.statusCode) {
    response.statusCode = 200;
  }

  return response;
}

//////////////////////
// Helper functions //
//////////////////////

function setNextjsServerWorkingDirectory() {
  // WORKAROUND: Set `NextServer` working directory (AWS specific) — https://github.com/serverless-stack/open-next#workaround-set-nextserver-working-directory-aws-specific
  process.chdir(__dirname);
}

function loadHtmlPages() {
  const filePath = path.join(nextDir, "server", "pages-manifest.json");
  const json = fs.readFileSync(filePath, "utf-8");
  return Object.entries(JSON.parse(json))
    .filter(([_, value]) => (value as string).endsWith(".html"))
    .map(([key]) => key);
}
