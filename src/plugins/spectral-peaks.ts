import BasePlugin, { type BasePluginEvents } from '../base-plugin.js'
import { getPixelRatio } from '../renderer-utils.js'

export type SpectralPeaksPluginOptions = {
  /** The frequency at which the low-cut filter ends (Hz). Defaults to 250. */
  lowCrossover?: number
  /** The frequency at which the high-cut filter starts (Hz). Defaults to 2000. */
  highCrossover?: number
  /** Color vibrancy (contrast). Defaults to 1.6. */
  vibrancy?: number
}

const defaultOptions = {
  lowCrossover: 250,
  highCrossover: 2000,
  vibrancy: 1.6,
}

export type SpectralPeaksPluginEvents = BasePluginEvents & {
  // No custom events yet
}

type BucketMetric = {
  rmsLow: number
  rmsMid: number
  rmsHigh: number
  totalRms: number
}

/**
 * SpectralPeaks plugin turns the waveform into a frequency-based visualization.
 * It uses a 3-band crossover to calculate the energy of low, mid, and high frequencies.
 */
class SpectralPeaksPlugin extends BasePlugin<SpectralPeaksPluginEvents, SpectralPeaksPluginOptions> {
  protected options: SpectralPeaksPluginOptions & typeof defaultOptions
  private bucketMetricsCache: { metrics: BucketMetric[]; max: number } | null = null
  private lastFilterParams = ''

  constructor(options?: SpectralPeaksPluginOptions) {
    super(options || {})
    this.options = Object.assign({}, defaultOptions, options)
  }

  public static create(options?: SpectralPeaksPluginOptions) {
    return new SpectralPeaksPlugin(options)
  }

  /** Called by wavesurfer, don't call manually */
  onInit() {
    if (!this.wavesurfer) {
      throw Error('WaveSurfer is not initialized')
    }

    this.wavesurfer.setOptions({
      renderFunction: (peaks, ctx) => this.renderWaveform(peaks, ctx),
    })

    this.subscriptions.push(
      this.wavesurfer.on('decode', () => {
        this.bucketMetricsCache = null
        this.lastFilterParams = ''
      }),
    )
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
  }

  private getAnalysisData(): { metrics: BucketMetric[]; max: number } | null {
    const buffer = this.wavesurfer?.getDecodedData()
    if (!buffer) return null

    const { lowCrossover, highCrossover } = this.options
    const filterParams = `${lowCrossover}-${highCrossover}`
    if (this.lastFilterParams === filterParams && this.bucketMetricsCache) {
      return this.bucketMetricsCache
    }

    const left = buffer.getChannelData(0)
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
    const totalSamples = buffer.length
    const sampleRate = buffer.sampleRate || 44100

    // Fixed analysis resolution: 1 bucket per 256 samples
    const bucketSize = 256
    const numBuckets = Math.ceil(totalSamples / bucketSize)
    const bucketMetrics = new Array<BucketMetric>(numBuckets)
    let maxRms = 0

    const rcLow = 1.0 / (2.0 * Math.PI * lowCrossover)
    const rcHigh = 1.0 / (2.0 * Math.PI * highCrossover)
    const dt = 1.0 / sampleRate
    const alphaLow = dt / (rcLow + dt)
    const alphaHigh = rcHigh / (rcHigh + dt)

    let lowPass = 0,
      highPass = 0,
      prevSample = 0

    for (let bucket = 0; bucket < numBuckets; bucket += 1) {
      const start = bucket * bucketSize
      const end = Math.min(totalSamples, start + bucketSize)
      let lowEnergy = 0,
        midEnergy = 0,
        highEnergy = 0

      for (let i = start; i < end; i += 1) {
        const sample = (left[i] + right[i]) * 0.5
        lowPass = lowPass + alphaLow * (sample - lowPass)
        highPass = alphaHigh * (highPass + sample - prevSample)
        prevSample = sample
        const midPass = sample - lowPass - highPass
        lowEnergy += lowPass * lowPass
        midEnergy += midPass * midPass
        highEnergy += highPass * highPass
      }

      const length = Math.max(1, end - start)
      const rmsLow = Math.sqrt(lowEnergy / length)
      const rmsMid = Math.sqrt(midEnergy / length)
      const rmsHigh = Math.sqrt(highEnergy / length)
      const totalRms = rmsLow + rmsMid + rmsHigh
      bucketMetrics[bucket] = { rmsLow, rmsMid, rmsHigh, totalRms }
      if (totalRms > maxRms) maxRms = totalRms
    }

    this.bucketMetricsCache = { metrics: bucketMetrics, max: maxRms }
    this.lastFilterParams = filterParams
    return this.bucketMetricsCache
  }

  private getColorForRange(offset: number, width: number, totalWidth: number): string[] {
    const analysis = this.getAnalysisData()
    if (!analysis || totalWidth <= 0) {
      return Array.from({ length: width }, () => 'rgba(96,165,250,0.95)')
    }

    const { metrics, max } = analysis
    const { vibrancy } = this.options
    const maxRms = max > 0 ? max : 1
    const colors = new Array<string>(width)

    for (let i = 0; i < width; i++) {
      const x = offset + i
      const bucketIndex = Math.floor((x / totalWidth) * metrics.length)
      const { rmsLow, rmsMid, rmsHigh, totalRms } = metrics[Math.min(metrics.length - 1, bucketIndex)]

      if (totalRms < 0.0001) {
        colors[i] = `rgba(50, 50, 50, 0.5)`
        continue
      }

      const rPow = Math.pow(rmsLow / totalRms, 0.7) * vibrancy
      const gPow = Math.pow(rmsMid / totalRms, 0.7) * vibrancy
      const bPow = Math.pow(rmsHigh / totalRms, 0.7) * vibrancy
      const alpha = this.clamp(0.6 + totalRms / maxRms, 0.7, 1.0)
      colors[i] = `rgba(${Math.round(this.clamp(rPow * 255, 0, 255))}, ${Math.round(
        this.clamp(gPow * 255, 0, 255),
      )}, ${Math.round(this.clamp(bPow * 255, 0, 255))}, ${alpha.toFixed(3)})`
    }

    return colors
  }

  private renderWaveform(peaks: Array<Float32Array | number[]>, ctx: CanvasRenderingContext2D) {
    const canvas = ctx.canvas
    const width = canvas.width
    const height = canvas.height
    const halfHeight = height / 2

    ctx.clearRect(0, 0, width, height)

    const firstChannel = peaks[0]
    if (!firstChannel || !firstChannel.length || !this.wavesurfer) return

    const pixelRatio = getPixelRatio()
    const totalWidth = this.wavesurfer.getWrapper().scrollWidth * pixelRatio
    const offset = (parseFloat(canvas.style.left) || 0) * pixelRatio
    const colors = this.getColorForRange(offset, width, totalWidth)

    const peakCount = firstChannel.length
    const bWidth = (this.wavesurfer.options.barWidth || 1) * pixelRatio
    const bGap = (this.wavesurfer.options.barGap || 0) * pixelRatio
    const bRadius = (this.wavesurfer.options.barRadius || 0) * pixelRatio
    const bAlign = this.wavesurfer.options.barAlign
    const step = Math.max(1, bWidth + bGap)

    for (let x = 0; x < width; x += step) {
      const peakIndex = Math.min(peakCount - 1, Math.floor((x / width) * peakCount))
      const peak = firstChannel[peakIndex] ?? 0
      const barHeightPx = Math.max(1, Math.pow(Math.abs(peak), 0.9) * halfHeight * 0.6)

      ctx.fillStyle = colors[Math.min(colors.length - 1, Math.floor(x))]
      ctx.beginPath()

      let rectY, rectH
      if (bAlign === 'top') {
        rectY = 0
        rectH = barHeightPx * 2
      } else if (bAlign === 'bottom') {
        rectY = height - barHeightPx * 2
        rectH = barHeightPx * 2
      } else {
        rectY = halfHeight - barHeightPx
        rectH = barHeightPx * 2
      }

      if (bRadius && 'roundRect' in ctx) {
        ;(
          ctx as CanvasRenderingContext2D & {
            roundRect: (x: number, y: number, width: number, height: number, radii?: number) => void
          }
        ).roundRect(x, rectY, bWidth, rectH, bRadius)
      } else {
        ctx.fillRect(x, rectY, bWidth, rectH)
      }
      ctx.fill()
    }

    if (!bAlign) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'
      ctx.fillRect(0, halfHeight - 0.5, width, 1)
    }
  }

  /** Update the plugin options */
  public setOptions(options: Partial<SpectralPeaksPluginOptions>) {
    this.options = Object.assign({}, this.options, options)
    this.bucketMetricsCache = null // Reset cache if crossover params might have changed
    this.wavesurfer?.setOptions({}) // Trigger re-render
  }

  /** Unmount the plugin */
  public destroy() {
    this.wavesurfer?.setOptions({ renderFunction: undefined })
    super.destroy()
  }
}

export default SpectralPeaksPlugin
