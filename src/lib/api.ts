export async function mcp(tool: string, args: any = {}, slot: string = "A") {
  const res = await fetch("/api/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args, slot }),
  });
  
  let data;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { raw: text };
  }
  
  if (!res.ok) {
    throw new Error((data && (data.error || data.message)) || "API error from " + tool);
  }
  
  return data;
}
