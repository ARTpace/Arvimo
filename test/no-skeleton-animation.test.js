// Regression test for patches/01-no-skeleton-animation.
// A scene with an animated object transform but NO Skeleton must still
// export its animation clip. Synthetic offline input, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertOsgjsToGlb } from "../vendor/upstream-src/lib/osgjs2gltf.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const CLIP_KEY = "a".repeat(32) + ".bin";

function geometryBin() {
  const verts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint8Array([0, 1, 2]);
  const bin = new Uint8Array(verts.byteLength + indices.byteLength);
  bin.set(new Uint8Array(verts.buffer));
  bin.set(indices, verts.byteLength);
  return { bin, vertBytes: verts.byteLength };
}

function animatedScene() {
  const { bin, vertBytes } = geometryBin();
  const clip = new Float32Array([0, 1, 0, 0, 0, 1, 0, 0]);
  const channel = {
    Name: "translate",
    TargetName: "MovingMesh",
    KeyFrames: {
      Time: { ItemSize: 1, Array: { Float32Array: { Offset: 0, Size: 2, File: CLIP_KEY } } },
      Key: { ItemSize: 3, Array: { Float32Array: { Offset: 8, Size: 2, File: CLIP_KEY } } },
    },
  };
  const scene = {
    "osg.Node": {
      Name: "root",
      UpdateCallbacks: [
        {
          "osgAnimation.BasicAnimationManager": {
            Animations: [
              {
                "osgAnimation.Animation": {
                  Name: "TranslateOnce",
                  Channels: [{ "osgAnimation.Vec3LerpChannel": channel }],
                },
              },
            ],
          },
        },
      ],
      Children: [
        {
          "osg.MatrixTransform": {
            Name: "MovingMesh",
            Matrix: IDENTITY,
            UpdateCallbacks: [
              {
                "osgAnimation.UpdateMatrixTransform": {
                  Name: "MovingMesh",
                  StackedTransforms: [
                    { "osgAnimation.StackedTranslate": { Translate: [0, 0, 0] } },
                    { "osgAnimation.StackedQuaternion": { Quaternion: [0, 0, 0, 1] } },
                    { "osgAnimation.StackedScale": { Scale: [1, 1, 1] } },
                  ],
                },
              },
            ],
            Children: [
              {
                "osg.Geometry": {
                  Name: "Triangle",
                  PrimitiveSetList: [
                    {
                      DrawElementsUByte: {
                        Mode: "TRIANGLES",
                        Indices: {
                          ItemSize: 1,
                          Type: "ELEMENT_ARRAY_BUFFER",
                          Array: { Uint8Array: { Offset: vertBytes, Size: 3, File: "model_file.bin" } },
                        },
                      },
                    },
                  ],
                  VertexAttributeList: {
                    Vertex: {
                      ItemSize: 3,
                      Type: "ARRAY_BUFFER",
                      Array: { Float32Array: { Offset: 0, Size: 3, File: "model_file.bin" } },
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };
  const bins = { [CLIP_KEY]: new Uint8Array(clip.buffer) };
  return { scene, geometry: bin, bins };
}

test("object animation without a Skeleton exports one clip", async () => {
  const { scene, geometry, bins } = animatedScene();
  const res = await convertOsgjsToGlb(scene, geometry, null, [], null, bins);
  assert.equal(res.geometryCount, 1);
  assert.equal(res.rig.skeletons, 0);
  assert.equal((res.json.animations || []).length, 1);
  const clip = res.json.animations[0];
  assert.equal(clip.name, "TranslateOnce");
  assert.equal(clip.channels.length, 1);
  assert.equal(clip.channels[0].target.path, "translation");
});

test("skeleton path still exports its clip (control)", async () => {
  const { scene, geometry, bins } = animatedScene();
  scene["osg.Node"].Children.push({
    "osgAnimation.Skeleton": {
      Name: "DiagnosticSkeleton",
      Children: [
        {
          "osgAnimation.Bone": {
            Name: "DiagnosticBone",
            Matrix: IDENTITY,
            InvBindMatrixInSkeletonSpace: IDENTITY,
            Children: [],
          },
        },
      ],
    },
  });
  const res = await convertOsgjsToGlb(scene, geometry, null, [], null, bins);
  assert.equal(res.geometryCount, 1);
  assert.equal((res.json.animations || []).length, 1);
});
