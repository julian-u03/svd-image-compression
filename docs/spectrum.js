// The chart reads the same result fields as the original application.
const spectrumSection = document.getElementById('spectrumSection');
const spectrumSvg = document.getElementById('spectrum');

// Draw the computed spectrum directly: a polyline is not a fitted curve model.
// The vertical axis uses log10 so small positive singular values remain visible.
export function renderSpectrum(result) {
  const values = result.singular_values;
  const maxIndex = result.max_rank;
  const namespace = "http://www.w3.org/2000/svg";

  spectrumSvg.replaceChildren();
  spectrumSection.hidden = false;

  if (values.length === 0) {
    add("text", { x: 380, y: 200, "text-anchor": "middle" }, "No values above the numerical threshold.");
    return;
  }

  const left = 95;
  const top = 40;
  const plotWidth = 640;
  const plotHeight = 310;
  const bottom = top + plotHeight;

  // Extend constant spectra by one decade on either side to avoid a zero axis range.
  const logs = values.map((value) => Math.log10(value));
  let lowerLog = Math.floor(Math.min(...logs));
  let upperLog = Math.ceil(Math.max(...logs));

  if (lowerLog === upperLog) {
    lowerLog -= 1;
    upperLog += 1;
  }

  // Pixel coordinates follow the SVG viewBox, independently of its CSS size.
  const x = (index) =>
    left +
    (maxIndex === 1
      ? plotWidth / 2
      : ((index - 1) / (maxIndex - 1)) * plotWidth);

  const yLog = (value) =>
    top + ((upperLog - value) / (upperLog - lowerLog)) * plotHeight;

  const y = (value) => yLog(Math.log10(value));

  // SVG elements must be created in the SVG namespace rather than the HTML namespace.
  function add(tag, attributes, text) {
    const element = document.createElementNS(namespace, tag);

    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }

    if (text !== undefined) element.textContent = text;
    spectrumSvg.append(element);
    return element;
  }

  // Draw decade grid lines, axis baselines and a small set of integer rank ticks.
  for (let exponent = lowerLog; exponent <= upperLog; exponent++) {
    const position = yLog(exponent);

    add("line", {
      x1: left,
      y1: position,
      x2: left + plotWidth,
      y2: position,
      stroke: "#ddd",
    });

    add(
      "text",
      {
        x: left - 12,
        y: position + 5,
        "text-anchor": "end",
      },
      `10^${exponent}`,
    );
  }

  add("line", {
    x1: left,
    y1: top,
    x2: left,
    y2: bottom,
    stroke: "#333",
  });

  add("line", {
    x1: left,
    y1: bottom,
    x2: left + plotWidth,
    y2: bottom,
    stroke: "#333",
  });

  const ticks = new Set(
    Array.from({ length: 5 }, (_, index) =>
      Math.round(1 + ((maxIndex - 1) * index) / 4),
    ),
  );

  for (const tick of ticks) {
    add("line", {
      x1: x(tick),
      y1: bottom,
      x2: x(tick),
      y2: bottom + 6,
      stroke: "#333",
    });

    add(
      "text",
      {
        x: x(tick),
        y: bottom + 25,
        "text-anchor": "middle",
      },
      tick,
    );
  }

  add(
    "text",
    {
      x: left + plotWidth / 2,
      y: 390,
      "text-anchor": "middle",
    },
    "Singular value index",
  );

  add(
    "text",
    {
      x: 20,
      y: top + plotHeight / 2,
      transform: `rotate(-90 20 ${top + plotHeight / 2})`,
      "text-anchor": "middle",
    },
    "Singular value (log scale)",
  );

  // A single positive component needs a point instead of a line segment.
  if (values.length > 1) {
    add("polyline", {
      points: values
        .map((value, index) => `${x(index + 1)},${y(value)}`)
        .join(" "),
      fill: "none",
      stroke: "#475569",
      "stroke-width": 2,
    });
  } else {
    add("circle", {
      cx: x(1),
      cy: y(values[0]),
      r: 3,
      fill: "#475569",
    });
  }

  const colors = ["#0072B2", "#D55E00", "#009E73", "#7C3AED"];

  // Duplicate user ranks share a marker; the recommendation keeps its own label.
  const markers = [...new Set(result.ranks)].map((rank) => ({
    rank,
    label: `k = ${rank}`,
  }));

  markers.push({
    rank: result.recommendation.rank,
    label: `Rec. k = ${result.recommendation.rank}`,
  });

  markers.forEach(({ rank, label }, index) => {
    // The recommendation keeps the same teal accent even when user ranks repeat.
    const color = index === markers.length - 1 ? '#087b75' : colors[index];

    add("line", {
      x1: x(rank),
      y1: top,
      x2: x(rank),
      y2: bottom,
      stroke: color,
      "stroke-dasharray": index === markers.length - 1 ? "2 4" : "5 4",
    });

    add(
      "text",
      {
        x: left + index * 180,
        y: 24,
        fill: color,
      },
      label,
    );

    if (rank <= values.length) {
      const point = add("circle", {
        cx: x(rank),
        cy: y(values[rank - 1]),
        r: 4,
        fill: color,
      });

      const title = document.createElementNS(namespace, "title");
      title.textContent = `Singular value ${rank}: ${values[rank - 1].toPrecision(4)}`;
      point.append(title);
    }
  });
}

