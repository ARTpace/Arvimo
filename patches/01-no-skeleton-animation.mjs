// Fix: object-transform / morph animations were dropped when the scene has no
// Skeleton, because animation-curve parsing was gated on skeletons.length.
// buildAnimationCurves() already returns [] when there is nothing to do.
export default {
  file: "vendor/upstream-src/lib/osgjs2gltf.js",
  replacements: [
    {
      id: "no-skeleton-animation",
      old: [
        "  const animationCurves = skeletons.skeletons.length",
        "    ? buildAnimationCurves(osgjs, animationBins)",
        "    : [];",
      ].join("\n"),
      new: [
        "  // Patched by sketchfab-exporter (01-no-skeleton-animation):",
        "  // object-transform and morph animations must not depend on a Skeleton.",
        "  const animationCurves = buildAnimationCurves(osgjs, animationBins);",
      ].join("\n"),
    },
  ],
};
