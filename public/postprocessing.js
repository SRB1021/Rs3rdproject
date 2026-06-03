(() => {
  // ../../../tmp/three_global_shim.js
  var T = globalThis.THREE;
  var ACESFilmicToneMapping = T.ACESFilmicToneMapping;
  var AdditiveBlending = T.AdditiveBlending;
  var BufferGeometry = T.BufferGeometry;
  var Clock = T.Clock;
  var Color = T.Color;
  var DataTexture = T.DataTexture;
  var DepthTexture = T.DepthTexture;
  var Float32BufferAttribute = T.Float32BufferAttribute;
  var HalfFloatType = T.HalfFloatType;
  var LinearFilter = T.LinearFilter;
  var MathUtils = T.MathUtils;
  var Mesh = T.Mesh;
  var MeshBasicMaterial = T.MeshBasicMaterial;
  var NearestFilter = T.NearestFilter;
  var OrthographicCamera = T.OrthographicCamera;
  var PlaneGeometry = T.PlaneGeometry;
  var RGBAFormat = T.RGBAFormat;
  var ShaderMaterial = T.ShaderMaterial;
  var UniformsUtils = T.UniformsUtils;
  var UnsignedShortType = T.UnsignedShortType;
  var Vector2 = T.Vector2;
  var Vector3 = T.Vector3;
  var WebGLMultipleRenderTargets = T.WebGLMultipleRenderTargets;
  var WebGLRenderTarget = T.WebGLRenderTarget;

  // node_modules/three/examples/jsm/shaders/CopyShader.js
  var CopyShader = {
    uniforms: {
      "tDiffuse": { value: null },
      "opacity": { value: 1 }
    },
    vertexShader: (
      /* glsl */
      `

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`
    ),
    fragmentShader: (
      /* glsl */
      `

		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;

		}`
    )
  };

  // node_modules/three/examples/jsm/postprocessing/Pass.js
  var Pass = class {
    constructor() {
      this.enabled = true;
      this.needsSwap = true;
      this.clear = false;
      this.renderToScreen = false;
    }
    setSize() {
    }
    render() {
      console.error("THREE.Pass: .render() must be implemented in derived pass.");
    }
  };
  var _camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  var _geometry = new BufferGeometry();
  _geometry.setAttribute("position", new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  _geometry.setAttribute("uv", new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  var FullScreenQuad = class {
    constructor(material) {
      this._mesh = new Mesh(_geometry, material);
    }
    dispose() {
      this._mesh.geometry.dispose();
    }
    render(renderer) {
      renderer.render(this._mesh, _camera);
    }
    get material() {
      return this._mesh.material;
    }
    set material(value) {
      this._mesh.material = value;
    }
  };

  // node_modules/three/examples/jsm/postprocessing/ShaderPass.js
  var ShaderPass = class extends Pass {
    constructor(shader, textureID) {
      super();
      this.textureID = textureID !== void 0 ? textureID : "tDiffuse";
      if (shader instanceof ShaderMaterial) {
        this.uniforms = shader.uniforms;
        this.material = shader;
      } else if (shader) {
        this.uniforms = UniformsUtils.clone(shader.uniforms);
        this.material = new ShaderMaterial({
          defines: Object.assign({}, shader.defines),
          uniforms: this.uniforms,
          vertexShader: shader.vertexShader,
          fragmentShader: shader.fragmentShader
        });
      }
      this.fsQuad = new FullScreenQuad(this.material);
    }
    render(renderer, writeBuffer, readBuffer) {
      if (this.uniforms[this.textureID]) {
        this.uniforms[this.textureID].value = readBuffer.texture;
      }
      this.fsQuad.material = this.material;
      if (this.renderToScreen) {
        renderer.setRenderTarget(null);
        this.fsQuad.render(renderer);
      } else {
        renderer.setRenderTarget(writeBuffer);
        if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
        this.fsQuad.render(renderer);
      }
    }
  };

  // node_modules/three/examples/jsm/postprocessing/MaskPass.js
  var MaskPass = class extends Pass {
    constructor(scene, camera) {
      super();
      this.scene = scene;
      this.camera = camera;
      this.clear = true;
      this.needsSwap = false;
      this.inverse = false;
    }
    render(renderer, writeBuffer, readBuffer) {
      const context = renderer.getContext();
      const state = renderer.state;
      state.buffers.color.setMask(false);
      state.buffers.depth.setMask(false);
      state.buffers.color.setLocked(true);
      state.buffers.depth.setLocked(true);
      let writeValue, clearValue;
      if (this.inverse) {
        writeValue = 0;
        clearValue = 1;
      } else {
        writeValue = 1;
        clearValue = 0;
      }
      state.buffers.stencil.setTest(true);
      state.buffers.stencil.setOp(context.REPLACE, context.REPLACE, context.REPLACE);
      state.buffers.stencil.setFunc(context.ALWAYS, writeValue, 4294967295);
      state.buffers.stencil.setClear(clearValue);
      state.buffers.stencil.setLocked(true);
      renderer.setRenderTarget(readBuffer);
      if (this.clear) renderer.clear();
      renderer.render(this.scene, this.camera);
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      renderer.render(this.scene, this.camera);
      state.buffers.color.setLocked(false);
      state.buffers.depth.setLocked(false);
      state.buffers.stencil.setLocked(false);
      state.buffers.stencil.setFunc(context.EQUAL, 1, 4294967295);
      state.buffers.stencil.setOp(context.KEEP, context.KEEP, context.KEEP);
      state.buffers.stencil.setLocked(true);
    }
  };
  var ClearMaskPass = class extends Pass {
    constructor() {
      super();
      this.needsSwap = false;
    }
    render(renderer) {
      renderer.state.buffers.stencil.setLocked(false);
      renderer.state.buffers.stencil.setTest(false);
    }
  };

  // node_modules/three/examples/jsm/postprocessing/EffectComposer.js
  var EffectComposer = class {
    constructor(renderer, renderTarget) {
      this.renderer = renderer;
      if (renderTarget === void 0) {
        const parameters = {
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          format: RGBAFormat
        };
        const size = renderer.getSize(new Vector2());
        this._pixelRatio = renderer.getPixelRatio();
        this._width = size.width;
        this._height = size.height;
        renderTarget = new WebGLRenderTarget(this._width * this._pixelRatio, this._height * this._pixelRatio, parameters);
        renderTarget.texture.name = "EffectComposer.rt1";
      } else {
        this._pixelRatio = 1;
        this._width = renderTarget.width;
        this._height = renderTarget.height;
      }
      this.renderTarget1 = renderTarget;
      this.renderTarget2 = renderTarget.clone();
      this.renderTarget2.texture.name = "EffectComposer.rt2";
      this.writeBuffer = this.renderTarget1;
      this.readBuffer = this.renderTarget2;
      this.renderToScreen = true;
      this.passes = [];
      if (CopyShader === void 0) {
        console.error("THREE.EffectComposer relies on CopyShader");
      }
      if (ShaderPass === void 0) {
        console.error("THREE.EffectComposer relies on ShaderPass");
      }
      this.copyPass = new ShaderPass(CopyShader);
      this.clock = new Clock();
    }
    swapBuffers() {
      const tmp = this.readBuffer;
      this.readBuffer = this.writeBuffer;
      this.writeBuffer = tmp;
    }
    addPass(pass) {
      this.passes.push(pass);
      pass.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
    }
    insertPass(pass, index) {
      this.passes.splice(index, 0, pass);
      pass.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
    }
    removePass(pass) {
      const index = this.passes.indexOf(pass);
      if (index !== -1) {
        this.passes.splice(index, 1);
      }
    }
    isLastEnabledPass(passIndex) {
      for (let i = passIndex + 1; i < this.passes.length; i++) {
        if (this.passes[i].enabled) {
          return false;
        }
      }
      return true;
    }
    render(deltaTime) {
      if (deltaTime === void 0) {
        deltaTime = this.clock.getDelta();
      }
      const currentRenderTarget = this.renderer.getRenderTarget();
      let maskActive = false;
      for (let i = 0, il = this.passes.length; i < il; i++) {
        const pass = this.passes[i];
        if (pass.enabled === false) continue;
        pass.renderToScreen = this.renderToScreen && this.isLastEnabledPass(i);
        pass.render(this.renderer, this.writeBuffer, this.readBuffer, deltaTime, maskActive);
        if (pass.needsSwap) {
          if (maskActive) {
            const context = this.renderer.getContext();
            const stencil = this.renderer.state.buffers.stencil;
            stencil.setFunc(context.NOTEQUAL, 1, 4294967295);
            this.copyPass.render(this.renderer, this.writeBuffer, this.readBuffer, deltaTime);
            stencil.setFunc(context.EQUAL, 1, 4294967295);
          }
          this.swapBuffers();
        }
        if (MaskPass !== void 0) {
          if (pass instanceof MaskPass) {
            maskActive = true;
          } else if (pass instanceof ClearMaskPass) {
            maskActive = false;
          }
        }
      }
      this.renderer.setRenderTarget(currentRenderTarget);
    }
    reset(renderTarget) {
      if (renderTarget === void 0) {
        const size = this.renderer.getSize(new Vector2());
        this._pixelRatio = this.renderer.getPixelRatio();
        this._width = size.width;
        this._height = size.height;
        renderTarget = this.renderTarget1.clone();
        renderTarget.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
      }
      this.renderTarget1.dispose();
      this.renderTarget2.dispose();
      this.renderTarget1 = renderTarget;
      this.renderTarget2 = renderTarget.clone();
      this.writeBuffer = this.renderTarget1;
      this.readBuffer = this.renderTarget2;
    }
    setSize(width, height) {
      this._width = width;
      this._height = height;
      const effectiveWidth = this._width * this._pixelRatio;
      const effectiveHeight = this._height * this._pixelRatio;
      this.renderTarget1.setSize(effectiveWidth, effectiveHeight);
      this.renderTarget2.setSize(effectiveWidth, effectiveHeight);
      for (let i = 0; i < this.passes.length; i++) {
        this.passes[i].setSize(effectiveWidth, effectiveHeight);
      }
    }
    setPixelRatio(pixelRatio) {
      this._pixelRatio = pixelRatio;
      this.setSize(this._width, this._height);
    }
  };
  var _camera2 = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  var _geometry2 = new BufferGeometry();
  _geometry2.setAttribute("position", new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  _geometry2.setAttribute("uv", new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));

  // node_modules/three/examples/jsm/postprocessing/RenderPass.js
  var RenderPass = class extends Pass {
    constructor(scene, camera, overrideMaterial, clearColor, clearAlpha) {
      super();
      this.scene = scene;
      this.camera = camera;
      this.overrideMaterial = overrideMaterial;
      this.clearColor = clearColor;
      this.clearAlpha = clearAlpha !== void 0 ? clearAlpha : 0;
      this.clear = true;
      this.clearDepth = false;
      this.needsSwap = false;
      this._oldClearColor = new Color();
    }
    render(renderer, writeBuffer, readBuffer) {
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      let oldClearAlpha, oldOverrideMaterial;
      if (this.overrideMaterial !== void 0) {
        oldOverrideMaterial = this.scene.overrideMaterial;
        this.scene.overrideMaterial = this.overrideMaterial;
      }
      if (this.clearColor) {
        renderer.getClearColor(this._oldClearColor);
        oldClearAlpha = renderer.getClearAlpha();
        renderer.setClearColor(this.clearColor, this.clearAlpha);
      }
      if (this.clearDepth) {
        renderer.clearDepth();
      }
      renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
      if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      renderer.render(this.scene, this.camera);
      if (this.clearColor) {
        renderer.setClearColor(this._oldClearColor, oldClearAlpha);
      }
      if (this.overrideMaterial !== void 0) {
        this.scene.overrideMaterial = oldOverrideMaterial;
      }
      renderer.autoClear = oldAutoClear;
    }
  };

  // node_modules/three/examples/jsm/shaders/LuminosityHighPassShader.js
  var LuminosityHighPassShader = {
    shaderID: "luminosityHighPass",
    uniforms: {
      "tDiffuse": { value: null },
      "luminosityThreshold": { value: 1 },
      "smoothWidth": { value: 1 },
      "defaultColor": { value: new Color(0) },
      "defaultOpacity": { value: 0 }
    },
    vertexShader: (
      /* glsl */
      `

		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`
    ),
    fragmentShader: (
      /* glsl */
      `

		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );

			vec3 luma = vec3( 0.299, 0.587, 0.114 );

			float v = dot( texel.xyz, luma );

			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );

			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );

			gl_FragColor = mix( outputColor, texel, alpha );

		}`
    )
  };

  // node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js
  var UnrealBloomPass = class _UnrealBloomPass extends Pass {
    constructor(resolution, strength, radius, threshold) {
      super();
      this.strength = strength !== void 0 ? strength : 1;
      this.radius = radius;
      this.threshold = threshold;
      this.resolution = resolution !== void 0 ? new Vector2(resolution.x, resolution.y) : new Vector2(256, 256);
      this.clearColor = new Color(0, 0, 0);
      const pars = { minFilter: LinearFilter, magFilter: LinearFilter, format: RGBAFormat };
      this.renderTargetsHorizontal = [];
      this.renderTargetsVertical = [];
      this.nMips = 5;
      let resx = Math.round(this.resolution.x / 2);
      let resy = Math.round(this.resolution.y / 2);
      this.renderTargetBright = new WebGLRenderTarget(resx, resy, pars);
      this.renderTargetBright.texture.name = "UnrealBloomPass.bright";
      this.renderTargetBright.texture.generateMipmaps = false;
      for (let i = 0; i < this.nMips; i++) {
        const renderTargetHorizonal = new WebGLRenderTarget(resx, resy, pars);
        renderTargetHorizonal.texture.name = "UnrealBloomPass.h" + i;
        renderTargetHorizonal.texture.generateMipmaps = false;
        this.renderTargetsHorizontal.push(renderTargetHorizonal);
        const renderTargetVertical = new WebGLRenderTarget(resx, resy, pars);
        renderTargetVertical.texture.name = "UnrealBloomPass.v" + i;
        renderTargetVertical.texture.generateMipmaps = false;
        this.renderTargetsVertical.push(renderTargetVertical);
        resx = Math.round(resx / 2);
        resy = Math.round(resy / 2);
      }
      if (LuminosityHighPassShader === void 0)
        console.error("THREE.UnrealBloomPass relies on LuminosityHighPassShader");
      const highPassShader = LuminosityHighPassShader;
      this.highPassUniforms = UniformsUtils.clone(highPassShader.uniforms);
      this.highPassUniforms["luminosityThreshold"].value = threshold;
      this.highPassUniforms["smoothWidth"].value = 0.01;
      this.materialHighPassFilter = new ShaderMaterial({
        uniforms: this.highPassUniforms,
        vertexShader: highPassShader.vertexShader,
        fragmentShader: highPassShader.fragmentShader,
        defines: {}
      });
      this.separableBlurMaterials = [];
      const kernelSizeArray = [3, 5, 7, 9, 11];
      resx = Math.round(this.resolution.x / 2);
      resy = Math.round(this.resolution.y / 2);
      for (let i = 0; i < this.nMips; i++) {
        this.separableBlurMaterials.push(this.getSeperableBlurMaterial(kernelSizeArray[i]));
        this.separableBlurMaterials[i].uniforms["texSize"].value = new Vector2(resx, resy);
        resx = Math.round(resx / 2);
        resy = Math.round(resy / 2);
      }
      this.compositeMaterial = this.getCompositeMaterial(this.nMips);
      this.compositeMaterial.uniforms["blurTexture1"].value = this.renderTargetsVertical[0].texture;
      this.compositeMaterial.uniforms["blurTexture2"].value = this.renderTargetsVertical[1].texture;
      this.compositeMaterial.uniforms["blurTexture3"].value = this.renderTargetsVertical[2].texture;
      this.compositeMaterial.uniforms["blurTexture4"].value = this.renderTargetsVertical[3].texture;
      this.compositeMaterial.uniforms["blurTexture5"].value = this.renderTargetsVertical[4].texture;
      this.compositeMaterial.uniforms["bloomStrength"].value = strength;
      this.compositeMaterial.uniforms["bloomRadius"].value = 0.1;
      this.compositeMaterial.needsUpdate = true;
      const bloomFactors = [1, 0.8, 0.6, 0.4, 0.2];
      this.compositeMaterial.uniforms["bloomFactors"].value = bloomFactors;
      this.bloomTintColors = [new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(1, 1, 1)];
      this.compositeMaterial.uniforms["bloomTintColors"].value = this.bloomTintColors;
      if (CopyShader === void 0) {
        console.error("THREE.UnrealBloomPass relies on CopyShader");
      }
      const copyShader = CopyShader;
      this.copyUniforms = UniformsUtils.clone(copyShader.uniforms);
      this.copyUniforms["opacity"].value = 1;
      this.materialCopy = new ShaderMaterial({
        uniforms: this.copyUniforms,
        vertexShader: copyShader.vertexShader,
        fragmentShader: copyShader.fragmentShader,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        transparent: true
      });
      this.enabled = true;
      this.needsSwap = false;
      this._oldClearColor = new Color();
      this.oldClearAlpha = 1;
      this.basic = new MeshBasicMaterial();
      this.fsQuad = new FullScreenQuad(null);
    }
    dispose() {
      for (let i = 0; i < this.renderTargetsHorizontal.length; i++) {
        this.renderTargetsHorizontal[i].dispose();
      }
      for (let i = 0; i < this.renderTargetsVertical.length; i++) {
        this.renderTargetsVertical[i].dispose();
      }
      this.renderTargetBright.dispose();
    }
    setSize(width, height) {
      let resx = Math.round(width / 2);
      let resy = Math.round(height / 2);
      this.renderTargetBright.setSize(resx, resy);
      for (let i = 0; i < this.nMips; i++) {
        this.renderTargetsHorizontal[i].setSize(resx, resy);
        this.renderTargetsVertical[i].setSize(resx, resy);
        this.separableBlurMaterials[i].uniforms["texSize"].value = new Vector2(resx, resy);
        resx = Math.round(resx / 2);
        resy = Math.round(resy / 2);
      }
    }
    render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
      renderer.getClearColor(this._oldClearColor);
      this.oldClearAlpha = renderer.getClearAlpha();
      const oldAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setClearColor(this.clearColor, 0);
      if (maskActive) renderer.state.buffers.stencil.setTest(false);
      if (this.renderToScreen) {
        this.fsQuad.material = this.basic;
        this.basic.map = readBuffer.texture;
        renderer.setRenderTarget(null);
        renderer.clear();
        this.fsQuad.render(renderer);
      }
      this.highPassUniforms["tDiffuse"].value = readBuffer.texture;
      this.highPassUniforms["luminosityThreshold"].value = this.threshold;
      this.fsQuad.material = this.materialHighPassFilter;
      renderer.setRenderTarget(this.renderTargetBright);
      renderer.clear();
      this.fsQuad.render(renderer);
      let inputRenderTarget = this.renderTargetBright;
      for (let i = 0; i < this.nMips; i++) {
        this.fsQuad.material = this.separableBlurMaterials[i];
        this.separableBlurMaterials[i].uniforms["colorTexture"].value = inputRenderTarget.texture;
        this.separableBlurMaterials[i].uniforms["direction"].value = _UnrealBloomPass.BlurDirectionX;
        renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
        renderer.clear();
        this.fsQuad.render(renderer);
        this.separableBlurMaterials[i].uniforms["colorTexture"].value = this.renderTargetsHorizontal[i].texture;
        this.separableBlurMaterials[i].uniforms["direction"].value = _UnrealBloomPass.BlurDirectionY;
        renderer.setRenderTarget(this.renderTargetsVertical[i]);
        renderer.clear();
        this.fsQuad.render(renderer);
        inputRenderTarget = this.renderTargetsVertical[i];
      }
      this.fsQuad.material = this.compositeMaterial;
      this.compositeMaterial.uniforms["bloomStrength"].value = this.strength;
      this.compositeMaterial.uniforms["bloomRadius"].value = this.radius;
      this.compositeMaterial.uniforms["bloomTintColors"].value = this.bloomTintColors;
      renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
      renderer.clear();
      this.fsQuad.render(renderer);
      this.fsQuad.material = this.materialCopy;
      this.copyUniforms["tDiffuse"].value = this.renderTargetsHorizontal[0].texture;
      if (maskActive) renderer.state.buffers.stencil.setTest(true);
      if (this.renderToScreen) {
        renderer.setRenderTarget(null);
        this.fsQuad.render(renderer);
      } else {
        renderer.setRenderTarget(readBuffer);
        this.fsQuad.render(renderer);
      }
      renderer.setClearColor(this._oldClearColor, this.oldClearAlpha);
      renderer.autoClear = oldAutoClear;
    }
    getSeperableBlurMaterial(kernelRadius) {
      return new ShaderMaterial({
        defines: {
          "KERNEL_RADIUS": kernelRadius,
          "SIGMA": kernelRadius
        },
        uniforms: {
          "colorTexture": { value: null },
          "texSize": { value: new Vector2(0.5, 0.5) },
          "direction": { value: new Vector2(0.5, 0.5) }
        },
        vertexShader: `varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,
        fragmentShader: `#include <common>
				varying vec2 vUv;
				uniform sampler2D colorTexture;
				uniform vec2 texSize;
				uniform vec2 direction;

				float gaussianPdf(in float x, in float sigma) {
					return 0.39894 * exp( -0.5 * x * x/( sigma * sigma))/sigma;
				}
				void main() {
					vec2 invSize = 1.0 / texSize;
					float fSigma = float(SIGMA);
					float weightSum = gaussianPdf(0.0, fSigma);
					vec3 diffuseSum = texture2D( colorTexture, vUv).rgb * weightSum;
					for( int i = 1; i < KERNEL_RADIUS; i ++ ) {
						float x = float(i);
						float w = gaussianPdf(x, fSigma);
						vec2 uvOffset = direction * invSize * x;
						vec3 sample1 = texture2D( colorTexture, vUv + uvOffset).rgb;
						vec3 sample2 = texture2D( colorTexture, vUv - uvOffset).rgb;
						diffuseSum += (sample1 + sample2) * w;
						weightSum += 2.0 * w;
					}
					gl_FragColor = vec4(diffuseSum/weightSum, 1.0);
				}`
      });
    }
    getCompositeMaterial(nMips) {
      return new ShaderMaterial({
        defines: {
          "NUM_MIPS": nMips
        },
        uniforms: {
          "blurTexture1": { value: null },
          "blurTexture2": { value: null },
          "blurTexture3": { value: null },
          "blurTexture4": { value: null },
          "blurTexture5": { value: null },
          "dirtTexture": { value: null },
          "bloomStrength": { value: 1 },
          "bloomFactors": { value: null },
          "bloomTintColors": { value: null },
          "bloomRadius": { value: 0 }
        },
        vertexShader: `varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,
        fragmentShader: `varying vec2 vUv;
				uniform sampler2D blurTexture1;
				uniform sampler2D blurTexture2;
				uniform sampler2D blurTexture3;
				uniform sampler2D blurTexture4;
				uniform sampler2D blurTexture5;
				uniform sampler2D dirtTexture;
				uniform float bloomStrength;
				uniform float bloomRadius;
				uniform float bloomFactors[NUM_MIPS];
				uniform vec3 bloomTintColors[NUM_MIPS];

				float lerpBloomFactor(const in float factor) {
					float mirrorFactor = 1.2 - factor;
					return mix(factor, mirrorFactor, bloomRadius);
				}

				void main() {
					gl_FragColor = bloomStrength * ( lerpBloomFactor(bloomFactors[0]) * vec4(bloomTintColors[0], 1.0) * texture2D(blurTexture1, vUv) +
						lerpBloomFactor(bloomFactors[1]) * vec4(bloomTintColors[1], 1.0) * texture2D(blurTexture2, vUv) +
						lerpBloomFactor(bloomFactors[2]) * vec4(bloomTintColors[2], 1.0) * texture2D(blurTexture3, vUv) +
						lerpBloomFactor(bloomFactors[3]) * vec4(bloomTintColors[3], 1.0) * texture2D(blurTexture4, vUv) +
						lerpBloomFactor(bloomFactors[4]) * vec4(bloomTintColors[4], 1.0) * texture2D(blurTexture5, vUv) );
				}`
      });
    }
  };
  UnrealBloomPass.BlurDirectionX = new Vector2(1, 0);
  UnrealBloomPass.BlurDirectionY = new Vector2(0, 1);

  // ../../../tmp/bloom_entry2.js
  window.PP = { EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, CopyShader };
})();
