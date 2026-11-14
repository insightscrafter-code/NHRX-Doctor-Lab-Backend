import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loginDoctor } from "./routes/auth.mjs";
import { createLabTestRequest, getLabRequests, loginLabStaff, uploadLabReport } from "./routes/lab.mjs";
import { getTodayAppointments } from "./routes/doctor.mjs";
import { createPatientMedicalRecord, downloadPatientReport, downloadPrescription, getPatientMedicalRecords, getPatientReports, getPatientTests } from "./routes/medicalRecords.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const frontendDist = resolve(projectRoot, "frontend", "dist");
const port = Number(process.env.BACKEND_PORT || 4000);
const serveFrontendEnabled = process.env.SERVE_FRONTEND !== "false";
const mimeTypes = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

async function toRequest(nodeRequest) {
  const chunks = [];
  let size = 0;
  for await (const chunk of nodeRequest) {
    size += chunk.length;
    if (size > 13 * 1024 * 1024) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${nodeRequest.headers.host || "localhost"}${nodeRequest.url}`, {
    method: nodeRequest.method,
    headers: nodeRequest.headers,
    ...(body && nodeRequest.method !== "GET" && nodeRequest.method !== "HEAD" ? { body } : {}),
  });
}

async function sendResponse(response, nodeResponse) {
  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

async function serveFrontend(pathname, nodeResponse) {
  let requestedPath = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!requestedPath) requestedPath = "index.html";
  const candidate = resolve(frontendDist, requestedPath);
  if (candidate !== frontendDist && !candidate.startsWith(`${frontendDist}${sep}`)) {
    nodeResponse.writeHead(400); nodeResponse.end("Bad request"); return;
  }
  let filePath = candidate;
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) filePath = resolve(filePath, "index.html");
  } catch {
    filePath = resolve(frontendDist, "index.html");
  }
  try {
    const content = await readFile(filePath);
    nodeResponse.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    nodeResponse.end(content);
  } catch {
    nodeResponse.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    nodeResponse.end("Build the React frontend with npm run build before serving it here.");
  }
}

const server = createServer(async (nodeRequest, nodeResponse) => {
  if (nodeRequest.method === "OPTIONS") { nodeResponse.writeHead(204); nodeResponse.end(); return; }

  try {
    const url = new URL(nodeRequest.url || "/", `http://${nodeRequest.headers.host || "localhost"}`);
    const request = await toRequest(nodeRequest);
    if (url.pathname === "/healthz" && nodeRequest.method === "GET") {
      await sendResponse(Response.json({ status: "ok" }), nodeResponse); return;
    }
    if (url.pathname === "/api/auth/login" && nodeRequest.method === "POST") {
      await sendResponse(await loginDoctor(request), nodeResponse); return;
    }
    if (url.pathname === "/api/lab/auth/login" && nodeRequest.method === "POST") {
      await sendResponse(await loginLabStaff(request), nodeResponse); return;
    }
    if (url.pathname === "/api/lab/requests" && nodeRequest.method === "GET") {
      await sendResponse(await getLabRequests(request), nodeResponse); return;
    }
    const labReportUpload = url.pathname.match(/^\/api\/lab\/requests\/(\d+)\/report\/?$/);
    if (labReportUpload && nodeRequest.method === "POST") {
      await sendResponse(await uploadLabReport(request, labReportUpload[1]), nodeResponse); return;
    }
    if (url.pathname === "/api/doctor/appointments/today" && nodeRequest.method === "GET") {
      await sendResponse(await getTodayAppointments(request), nodeResponse); return;
    }
    const patientRecords = url.pathname.match(/^\/api\/doctor\/patients\/([^/]+)\/records\/?$/);
    if (patientRecords && ["GET", "POST"].includes(nodeRequest.method)) {
      const nationalId = decodeURIComponent(patientRecords[1]);
      const response = nodeRequest.method === "POST"
        ? await createPatientMedicalRecord(request, nationalId)
        : await getPatientMedicalRecords(request, nationalId);
      await sendResponse(response, nodeResponse); return;
    }
    const labRequests = url.pathname.match(/^\/api\/doctor\/patients\/([^/]+)\/lab-requests\/?$/);
    if (labRequests && nodeRequest.method === "POST") {
      await sendResponse(await createLabTestRequest(request, decodeURIComponent(labRequests[1])), nodeResponse); return;
    }
    const reports = url.pathname.match(/^\/api\/doctor\/patients\/([^/]+)\/reports\/?$/);
    if (reports && nodeRequest.method === "GET") {
      await sendResponse(await getPatientReports(request, decodeURIComponent(reports[1])), nodeResponse); return;
    }
    const reportFile = url.pathname.match(/^\/api\/doctor\/patients\/([^/]+)\/reports\/(\d+)\/?$/);
    if (reportFile && nodeRequest.method === "GET") {
      await sendResponse(await downloadPatientReport(request, decodeURIComponent(reportFile[1]), reportFile[2]), nodeResponse); return;
    }
    const tests = url.pathname.match(/^\/api\/doctor\/patients\/([^/]+)\/tests\/?$/);
    if (tests && nodeRequest.method === "GET") {
      await sendResponse(await getPatientTests(request, decodeURIComponent(tests[1])), nodeResponse); return;
    }
    const prescription = url.pathname.match(/^\/api\/doctor\/patients\/([^/]+)\/records\/(\d+)\/prescription\/?$/);
    if (prescription && nodeRequest.method === "GET") {
      await sendResponse(await downloadPrescription(request, decodeURIComponent(prescription[1]), prescription[2]), nodeResponse); return;
    }
    if (url.pathname.startsWith("/api/")) {
      await sendResponse(Response.json({ message: "API route not found." }, { status: 404 }), nodeResponse); return;
    }
    if (!serveFrontendEnabled) {
      await sendResponse(Response.json({ message: "This service provides the NHRX API. The frontend is deployed separately." }, { status: 404 }), nodeResponse); return;
    }
    await serveFrontend(url.pathname, nodeResponse);
  } catch (error) {
    if (error?.status !== 413) console.error("Backend request failed:", error);
    nodeResponse.writeHead(error?.status === 413 ? 413 : 500, { "Content-Type": "application/json; charset=utf-8" });
    nodeResponse.end(JSON.stringify({ message: error?.status === 413 ? "This upload is too large. Choose a smaller file and try again." : "Something went wrong. Please try again." }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Doctor backend listening at http://localhost:${port}`);
});
