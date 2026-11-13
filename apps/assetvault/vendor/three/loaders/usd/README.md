Three.js USD components, MIT license (see LICENSE).
Source: https://github.com/mrdoob/three.js/tree/49ab5be70757f55c2ae9e9b19c10a8b4b850229b/examples/jsm/loaders/usd
USDComposer: optional setPriority/setCache calls for the existing Three.js r160 runtime.

Local fixes: compose only the exact referenced prim subtree; preserve reference transforms; normalize relative paths; propagate texture completion; reject cyclic references. Referenced layers do not apply stage metadata a second time.
