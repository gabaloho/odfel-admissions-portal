const PDFDocument = require("pdfkit");

function renderAcademicRecord({ institutionName, studentName, matriculationNumber, programName, results }, output) {
  const pdf = new PDFDocument({ size: "A4", margin: 56, info: { Title: "Unofficial Academic Record" } });
  pdf.pipe(output);

  function header() {
    pdf.x = pdf.page.margins.left;
    pdf.y = pdf.page.margins.top;
    pdf.fillColor("#9a2525").font("Helvetica-Bold").fontSize(13).text("UNOFFICIAL ACADEMIC RECORD", { align: "center" });
    pdf.font("Helvetica").fontSize(9).text("Not a certified transcript. GPA and graduation status are not calculated.", { align: "center" });
    pdf.moveDown();
  }
  pdf.on("pageAdded", header);
  header();

  pdf.fillColor("#0d2a3a").font("Helvetica-Bold").fontSize(15).text(institutionName);
  pdf.font("Helvetica").fontSize(10).text(`Student: ${studentName}`);
  pdf.text(`Matriculation number: ${matriculationNumber}`);
  pdf.text(`Programme: ${programName}`);
  pdf.text(`Generated: ${new Date().toISOString()}`);
  pdf.moveDown();

  if (!results.length) pdf.text("No published results.");
  for (const result of results) {
    pdf.fillColor("#0d2a3a").font("Helvetica-Bold").fontSize(11).text(`${result.sessionName} / ${result.termName} - ${result.code}: ${result.title}`);
    pdf.font("Helvetica").fontSize(10).text(`Score: ${result.publication.score} | Grade: ${result.publication.grade} | Grade points: ${result.publication.gradePoints} | Units: ${result.publication.creditUnits}`);
    pdf.moveDown(0.5);
  }
  pdf.end();
}

module.exports = { renderAcademicRecord };
