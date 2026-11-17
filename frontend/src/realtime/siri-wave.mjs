// 通话球里的声波（WebGL）。着色器改自 aaaa-zhen/glsl-playground 的 siri-wave.html（MIT License）。
// 改动：原版三段频带按时间伪造起伏，这里换成 uniform，由真实音量驱动；
// res=0 收成一颗光点（连接中），res=1 展开成声波；输出带 alpha，叠在深色球底上。
const FS = `precision highp float;
uniform vec2 iResolution; uniform float iTime;
uniform float uLevel, uLow, uMid, uHigh, uRes;
const float PI = 3.14159265359;
const float AMPLITUDE = 0.5, FREQ = 1.1, ABER_FREQ = 1.0, SPEED = 2.4, WAVE_SCALE = 0.95, ABERRATION = 2.6;
const float THICKNESS = 3.0, INTENSITY = 2.0, FALLOFF = 1.7, EDGE_MASK = 0.4, BAND_FILL = 30000.0, BAND_THICK = 0.08;
const float SOFTNESS = 2.5, LOW_AMP = 6.0, LOW_INT = 1.5, MID_ABER = 0.8, MID_ABAMP = 0.05, MID_SOFT = 0.4;
const float HIGH_ABER = 0.5, HIGH_ABAMP = 0.06, UNRES_SCALE = 0.14;
vec3 spectral4(int s){ float x = float(s); return clamp(vec3(abs(x-3.0)-1.0, 2.0-abs(x-2.0), 2.0-abs(x-4.0)), 0.0, 1.0); }
void main(){
  vec2 R = iResolution.xy; float aspect = R.x / R.y;
  vec2 p = (gl_FragCoord.xy + 0.5) * 2.0 / R - 1.0; p.x *= aspect; float yScreen = p.y; p /= WAVE_SCALE;
  float low = uLow, mid = uMid, high = uHigh, res = uRes;
  float drift = mod(iTime, 20.0*PI) * SPEED;
  float xN = p.x / max(aspect, 1.0); float env = cos(PI*0.5*min(abs(0.9*xN), 1.0)); env *= env;
  float A1 = AMPLITUDE*(0.08 + 0.92*uLevel) + 0.01*low*LOW_AMP*uLevel;
  float A2 = A1 + (mid*MID_ABAMP + high*HIGH_ABAMP)*uLevel;
  float AB = (ABERRATION + mid*MID_ABER + high*HIGH_ABER)*res;
  float th = mix(0.1, 0.01*THICKNESS, res);
  float inten = mix(0.1, 0.01*(INTENSITY + low*LOW_INT), res);
  float soft = 0.01*res*max(0.0, SOFTNESS + mid*MID_SOFT);
  float dUnres = max(length(p) - UNRES_SCALE, 0.0) * 6.0;
  float yMain = A1*env*res*sin(p.x*FREQ + drift);
  float bandAmt = 1e-4*BAND_FILL*inten*res; vec3 num = vec3(0.0), den = vec3(0.0);
  for(int s = 0; s < 4; s++){
    vec3 hue = mix(vec3(1.0), spectral4(s), res); den += hue;
    float ab = mix(-AB, AB, float(s)/3.0);
    float yL = A2*env*res*sin(p.x*ABER_FREQ + drift + ab);
    float d = mix(dUnres, abs(p.y - yL), res);
    float lor = mix(1.0/(1.0 + (0.02*d)*(0.02*d)), 1.0, res);
    float line = inten / (sqrt(d*d + soft*soft) + th);
    float lo = min(yMain, yL), hi = max(yMain, yL);
    float dBand = max(0.0, max(p.y - hi, lo - p.y));
    num += hue*lor*(line + bandAmt/(dBand + BAND_THICK));
  }
  vec3 col = num / den;
  float dM = mix(dUnres, abs(p.y - yMain), res);
  float lorM = mix(1.0/(1.0 + (0.02*dM)*(0.02*dM)), 1.0, res);
  float boost = (1.0 - res)*(0.6*low + 0.25);
  col += 0.5*inten*(lorM + boost) / (sqrt(dM*dM + soft*soft) + th);
  col = pow(max(col, 0.0), vec3(1.5));
  float emT = clamp((abs(yScreen) - 1.0) / (-EDGE_MASK), 0.0, 1.0); float em = emT*emT*(3.0 - 2.0*emT);
  col *= mix(1.0, em*exp(-pow(xN*FALLOFF, 2.0)), res);
  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(col, max(col.r, max(col.g, col.b)));
}`
const VS = 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }'
const KEYS = ['Level', 'Low', 'Mid', 'High', 'Res']

// 拿不到 WebGL 或着色器编译失败时返回 null，调用方退回 CSS 光球。
export function createSiriWave(canvas, { renderScale = 0.75, maxDpr = 1.5 } = {}) {
  let gl
  try { gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }) } catch { return null }
  if (!gl) return null
  const shader = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
  }
  const vs = shader(gl.VERTEX_SHADER, VS), fs = shader(gl.FRAGMENT_SHADER, FS)
  if (!vs || !fs) return null
  const program = gl.createProgram(); gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
  gl.useProgram(program)
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos'); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
  const uRes2 = gl.getUniformLocation(program, 'iResolution'), uTime = gl.getUniformLocation(program, 'iTime')
  const uniforms = KEYS.map(k => [k.toLowerCase(), gl.getUniformLocation(program, 'u' + k)])
  return {
    draw(time, params) {
      const scale = Math.min(globalThis.devicePixelRatio || 1, maxDpr) * renderScale
      const w = Math.max(1, Math.round(canvas.clientWidth * scale)), h = Math.max(1, Math.round(canvas.clientHeight * scale))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      gl.viewport(0, 0, w, h)
      gl.uniform2f(uRes2, w, h); gl.uniform1f(uTime, time)
      for (const [key, loc] of uniforms) gl.uniform1f(loc, params[key] || 0)
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    destroy() {
      gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vs); gl.deleteShader(fs)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
