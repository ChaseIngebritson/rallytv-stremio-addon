import { defineRailway, github, project, service } from "railway/iac";

// This repository manages only its own resources in the environment.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "rallytv-stremio-addon";

export default defineRailway(() => {
  const rallytvStremioAddon = service("rallytv-stremio-addon", {
    source: github("ChaseIngebritson/rallytv-stremio-addon", {
      branch: "main",
      checkSuites: false,
    }),
    build: { builder: "RAILPACK", buildEnvironment: "V3" },
    start: "npx tsx src/index.ts",
    healthcheck: "/health",
    healthcheckTimeout: 30,
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      RALLYTV_LOCALE: {
        value: "en",
        isOptional: true,
        description:
          "Rally.tv API locale (default en). Also configurable later in the Stremio addon settings.",
      },
      RALLYTV_COUNTRY: {
        value: "us",
        isOptional: true,
        description:
          "Rally.tv country code (default us). Also configurable later in the Stremio addon settings.",
      },
      ADDON_BASE_URL: {
        isOptional: true,
        description:
          "Optional absolute public base URL for remux stream links. Leave empty to use the Railway public domain automatically.",
      },
    },
  });

  return project("rallytv-stremio-addon", {
    variables: { managed: true },
    resources: [rallytvStremioAddon],
  });
});
