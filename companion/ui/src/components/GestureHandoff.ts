/**
 * Derived from Ariakage/live2d-agent-kit (templates/web-preview/gesture-handoff.js) — MIT License.
 * Smoothly lowers the model's arm sleeve before switching arm-lift gestures to prevent ghosting/elbow breaks.
 */
const ARM_PARAM_IDS = ['ParamArmRLift', 'ParamArmRPose', 'ParamHandRForm', 'ParamHandRWave'] as const;
type ArmParamId = (typeof ARM_PARAM_IDS)[number];

const ease = (t: number) => t * t * (3 - 2 * t);

export class GestureHandoff {
  public active = false;
  private from: Record<ArmParamId, number> = {
    ParamArmRLift: 0,
    ParamArmRPose: 0,
    ParamHandRForm: 0,
    ParamHandRWave: 0,
  };
  private values: Record<ArmParamId, number> = { ...this.from };
  private elapsed = 0;
  private lowerSeconds = 0;
  private resetSeconds = 0;
  private resolveFn: ((completed: boolean) => void) | null = null;

  start(parameters: Partial<Record<ArmParamId, number>>): Promise<boolean> {
    this.cancel();
    if (!ARM_PARAM_IDS.every((id) => Number.isFinite(parameters[id]))) {
      return Promise.resolve(true);
    }
    this.from = {
      ParamArmRLift: Number(parameters.ParamArmRLift ?? 0),
      ParamArmRPose: Number(parameters.ParamArmRPose ?? 0),
      ParamHandRForm: Number(parameters.ParamHandRForm ?? 0),
      ParamHandRWave: Number(parameters.ParamHandRWave ?? 0),
    };
    this.values = { ...this.from };
    this.elapsed = 0;
    this.lowerSeconds = this.from.ParamArmRLift > 0 ? 0.8 : 0;
    this.resetSeconds = ARM_PARAM_IDS.slice(1).some((id) => this.from[id] !== 0) ? 0.4 : 0;
    if (!this.lowerSeconds && !this.resetSeconds) return Promise.resolve(true);
    this.active = true;
    return new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }

  step(seconds: number): Record<ArmParamId, number> | null {
    if (!this.active) return null;
    if (Number.isFinite(seconds) && seconds > 0) {
      this.elapsed += Math.min(seconds, 0.05);
    }
    if (this.elapsed < this.lowerSeconds) {
      const weight = 1 - ease(this.elapsed / this.lowerSeconds);
      this.values = { ...this.from, ParamArmRLift: this.from.ParamArmRLift * weight };
    } else {
      const weight = this.resetSeconds
        ? 1 - ease(Math.min(1, (this.elapsed - this.lowerSeconds) / this.resetSeconds))
        : 0;
      this.values = {
        ParamArmRLift: 0,
        ParamArmRPose: this.from.ParamArmRPose * weight,
        ParamHandRForm: this.from.ParamHandRForm * weight,
        ParamHandRWave: this.from.ParamHandRWave * weight,
      };
    }
    if (this.elapsed >= this.lowerSeconds + this.resetSeconds) {
      this.active = false;
      this.resolveFn?.(true);
      this.resolveFn = null;
    }
    return this.values;
  }

  cancel(): void {
    this.active = false;
    this.resolveFn?.(false);
    this.resolveFn = null;
  }
}
