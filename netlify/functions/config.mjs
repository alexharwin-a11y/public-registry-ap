export default async function handler() {
  return new Response(
    JSON.stringify({
      updatesJsonUrl: process.env.UPDATES_JSON_URL || "/data/updates.json"
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300"
      }
    }
  );
}
