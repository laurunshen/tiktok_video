export function createSmartSamplingStrategy(overrides = {}) {
  return {
    name: 'smart_info_sampling_v1',
    fps: {
      base: 4,
      hook: 6,
      hookDuration: 3,
      ...overrides.fps,
    },
    maxFrames: overrides.maxFrames ?? 80,
    sceneThreshold: overrides.sceneThreshold ?? 0.3,
    sceneContextOffsets: overrides.sceneContextOffsets ?? [-0.5, -0.25, 0.25, 0.5],
    scoreWeights: {
      sharpness: 0.22,
      braDetail: 0.22,
      motion: 0.2,
      sceneContext: 0.14,
      diversity: 0.1,
      ...overrides.scoreWeights,
    },
    hookBonus: overrides.hookBonus ?? 0.16,
    budget: {
      hookRatio: 0.28,
      sceneRatio: 0.2,
      actionRatio: 0.32,
      detailRatio: 0.12,
      minHook: 12,
      minScene: 10,
      minAction: 16,
      minDetail: 8,
      ...overrides.budget,
    },
  }
}
