function validDecimal(value, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
}

function validateGradingScale(input) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) return { error: "Enter a grading scale name of up to 100 characters." };
  if (!Array.isArray(input.bands) || !input.bands.length || input.bands.length > 30) return { error: "Enter between 1 and 30 grade bands." };
  const bands = [];
  for (const band of input.bands) {
    const label = typeof band?.label === "string" ? band.label.trim() : "";
    if (!label || label.length > 30 || !validDecimal(band.minimumScore, 100) || !validDecimal(band.gradePoints, 100)) return { error: "Each band needs a label, minimum score and grade points with at most two decimal places." };
    bands.push({ label, minimumScore: band.minimumScore, gradePoints: band.gradePoints });
  }
  bands.sort((a, b) => a.minimumScore - b.minimumScore);
  if (bands[0].minimumScore !== 0 || new Set(bands.map((band) => band.minimumScore)).size !== bands.length || new Set(bands.map((band) => band.label.toLowerCase())).size !== bands.length) return { error: "Grade bands must start at zero and have unique minimum scores and labels." };
  return { values: { name, bands } };
}

function gradeScore(score, bands) {
  return [...bands].reverse().find((band) => score >= band.minimumScore);
}

module.exports = { validDecimal, validateGradingScale, gradeScore };
