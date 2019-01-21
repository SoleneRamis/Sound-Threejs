class Sound {

    /**
       * src        : path to mp3
       * bpm        : beat per minute
       * offsetTime : remove blank sound at start for beat calculation (in seconds)
       * callback   : ready callback
       * debug      : enable debug display
       */
    constructor(src, bpm, offsetTime, callback, debug = false) {

        // create context
        this.ctx;
        try {
            window.AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
        }
        catch (e) {
            throw new Error('Web Audio API is not supported in this browser');
        }

        // values
        this._bpm = bpm;
        this._beatDuration = 60 / this._bpm;
        this._offsetTime = offsetTime;
        this._sections = [];
        this._kicks = [];
        this._beats = [];
        this._startTime = 0;
        this._pauseTime = 0;
        this._isPlaying = false;
        this._isLoaded = false;
        this._progress = 0;

        // events
        this._onUpdate = this.onUpdate.bind(this);
        this._onEnded = this.onEnded.bind(this);

        // create gain
        this.gainNode = this.ctx.createGain();
        this.gainNode.connect(this.ctx.destination);

        // create analyser
        this.analyserNode = this.ctx.createAnalyser();
        this.analyserNode.connect(this.gainNode);
        this.analyserNode.smoothingTimeConstant = .8;
        this.analyserNode.fftSize = 512;
        let bufferLength = this.analyserNode.frequencyBinCount;
        this.frequencyDataArray = new Uint8Array(bufferLength);
        this.timeDomainDataArray = new Uint8Array(bufferLength);

        // create debug
        if (debug) this.debug = new Debug(this);

        // load
        this._load(src, callback);

        // update
        window.requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame;
        window.cancelAnimationFrame = window.cancelAnimationFrame || window.mozCancelAnimationFrame;
    }

    // load MP3

    _load(src, callback) {

        if (src) {

            this._isLoaded = false;
            this._progress = 0;

            // Load asynchronously
            let request = new XMLHttpRequest();
            request.open("GET", src, true);
            request.responseType = "arraybuffer";
            request.onprogress = (e) => {
                this._progress = e.loaded / e.total;
            };
            request.onload = () => {
                this.ctx.decodeAudioData(request.response, (buffer) => {
                    this._buffer = buffer;
                    this._isLoaded = true;
                    if (callback) callback();
                }, function (e) {
                    console.log(e);
                });
            };
            request.send();
        }
    }

    get progress() {

        return this._progress;
    }

    get isLoaded() {

        return this._isLoaded;
    }

    // sound actions

    play(offset = 0) {

        if (this.req) cancelAnimationFrame(this.req);
        this._onUpdate();

        this._isPlaying = true;
        let elapseTime = this._pauseTime - this._startTime + offset;
        this._startTime = this.ctx.currentTime - elapseTime;

        this.sourceNode = this.ctx.createBufferSource();
        this.sourceNode.connect(this.analyserNode);
        this.sourceNode.buffer = this._buffer;
        this.sourceNode.start(0, elapseTime);
        this.sourceNode.addEventListener('ended', this._onEnded, false);
    }

    pause() {

        if (this.req) cancelAnimationFrame(this.req);

        if (this.sourceNode) {
            this.sourceNode.removeEventListener('ended', this._onEnded, false);
            this.sourceNode.stop(0);
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }

        this._pauseTime = this.ctx.currentTime;
        this._isPlaying = false;
    }

    get duration() {

        return this._isLoaded ? this._buffer.duration : 0;
    }

    get time() {

        return this.isPlaying ? this.ctx.currentTime - this._startTime : this._pauseTime - this._startTime;
    }

    set volume(value) {

        this.gainNode.gain.value = value;
    }

    get volume() {

        return this.gainNode.gain.value;
    }

    get isPlaying() {

        return this._isPlaying;
    }

    // callback at specific time

    before(label, time, callback) {

        let _this = this;
        this._sections.push({
            label: label,
            condition: function () {
                return _this.time < time;
            },
            callback: callback
        });
        return this;
    }

    after(label, time, callback) {

        let _this = this;
        this._sections.push({
            label: label,
            condition: function () {
                return _this.time > time;
            },
            callback: callback
        });
        return this;
    }

    between(label, startTime, endTime, callback) {

        let _this = this;
        this._sections.push({
            label: label,
            condition: function () {
                return _this.time > startTime && _this.time < endTime;
            },
            callback: callback
        });
        return this;
    }

    onceAt(label, time, callback) {

        let _this = this;
        let thisSection = null;
        this._sections.push({
            label: label,
            condition: function () {
                return _this.time > time && !this.called;
            },
            callback: function () {
                console.log('once :', thisSection.label)
                callback.call(this);
                thisSection.called = true;
            },
            called: false
        });
        thisSection = this._sections[this._sections.length - 1];
        return this;
    }

    // sound analyser

    getSpectrum() {

        this.analyserNode.getByteFrequencyData(this.frequencyDataArray);

        return this.frequencyDataArray;
    }

    getWaveform() {

        this.analyserNode.getByteTimeDomainData(this.timeDomainDataArray);

        return this.timeDomainDataArray;
    }

    getFrequency(freq, endFreq = null) {

        let sum = 0;
        let spectrum = this.getSpectrum();
        if (endFreq !== undefined) {
            for (var i = freq; i <= endFreq; i++) {
                sum += spectrum[i];
            }
            return sum / (endFreq - freq + 1);
        } else {
            return spectrum[freq];
        }
    }

    /**
       * Kicks are detected when the amplitude (normalized values between 0 and 1) of a specified frequency, or the max amplitude over a range, is greater than the minimum threshold, as well as greater than the previously registered kick's amplitude, which is decreased by the decay rate per frame.
       * frequency : the frequency (element of the spectrum) to check for a spike. Can be a single frequency (number) or a range (2 element array) that uses the frequency with highest amplitude.
       * threshold : the minimum amplitude of the frequency range in order for a kick to occur.
       * decay     : the rate that the previously registered kick's amplitude is reduced by on every frame.
       * onKick    : the callback to be called when a kick is detected.
       * offKick   : the callback to be called when there is no kick on the current frame.
       */

    createKick({ frequency, threshold, decay, onKick, offKick }) {

        let kick = new Kick({ frequency, threshold, decay, onKick, offKick });
        this._kicks.push(kick);
        return kick;
    }

    /**
       * Beat are detected when the time correspond to duration of one beat (in second) multiplied by the factor
       * factor : the factor to multiply the duration of one beat
       * onBeat : the callback to be called when a beat is detected.
       */

    createBeat({ factor, onBeat }) {

        let beat = new Beat({ factor, onBeat });
        this._beats.push(beat);
        return beat;
    }

    get beatDuration() {

        return this._beatDuration;
    }

    //

    onUpdate() {

        this.req = requestAnimationFrame(this._onUpdate);

        for (let i in this._sections) {
            if (this._sections[i].condition())
                this._sections[i].callback.call(this);
        }

        let spectrum = this.getSpectrum();
        for (let i in this._kicks) {
            this._kicks[i].calc(spectrum);
        }

        let time = Math.max(0, this.time - this._offsetTime);
        for (let i in this._beats) {
            this._beats[i].calc(time, this._beatDuration);
        }

        if (this.debug) this.debug.draw();
    }

    onEnded() {

        this.stop();
    }
};

class Kick {

    constructor({ frequency, threshold, decay, onKick, offKick }) {

        this.frequency = frequency !== undefined ? frequency : [0, 10];
        this.threshold = threshold !== undefined ? threshold : 0.3;
        this.decay = decay !== undefined ? decay : 0.02;
        this.onKick = onKick;
        this.offKick = offKick;
        this.isOn = false;
        this.isKick = false;
        this.currentThreshold = this.threshold;
    }

    on() {

        this.isOn = true;
    }

    off() {

        this.isOn = false;
    }

    set({ frequency, threshold, decay, onKick, offKick }) {

        this.frequency = frequency !== undefined ? frequency : this.frequency;
        this.threshold = threshold !== undefined ? threshold : this.threshold;
        this.decay = decay !== undefined ? decay : this.decay;
        this.onKick = onKick || this.onKick;
        this.offKick = offKick || this.offKick;
    }

    calc(spectrum) {

        if (!this.isOn) { return; }
        let magnitude = this.maxAmplitude(spectrum, this.frequency);
        if (magnitude >= this.currentThreshold && magnitude >= this.threshold) {
            this.currentThreshold = magnitude;
            this.onKick && this.onKick(magnitude);
            this.isKick = true;
        } else {
            this.offKick && this.offKick(magnitude);
            this.currentThreshold -= this.decay;
            this.isKick = false;
        }
    }

    maxAmplitude(fft, frequency) {

        let max = 0;

        // Sloppy array check
        if (!frequency.length) {
            return frequency < fft.length ? fft[~~frequency] : null;
        }

        for (var i = frequency[0], l = frequency[1]; i <= l; i++) {
            if (fft[i] > max) { max = fft[i]; }
        }

        return max;
    }
};

class Beat {

    constructor({ factor, onBeat }) {

        this.factor = factor !== undefined ? factor : 1;
        this.onBeat = onBeat;
        this.isOn = false;
        this.currentTime = 0;
    }

    on() {

        this.isOn = true;
    }

    off() {

        this.isOn = false;
    }

    set({ factor, onBeat }) {

        this.factor = factor !== undefined ? factor : this.factor;
        this.onBeat = onBeat || this.onBeat;
    }

    calc(time, beatDuration) {
        if (time == 0) { return; }
        let beatDurationFactored = beatDuration * this.factor;
        if (time >= this.currentTime + beatDurationFactored) {
            if (this.isOn) this.onBeat && this.onBeat();
            this.currentTime += beatDurationFactored;
        }
    }
}

class Debug {

    constructor(sound) {

        this.sound = sound;

        this.canvas = document.createElement('canvas');
        this.canvas.width = 512;
        this.canvas.height = 300;
        this.canvas.style.position = 'absolute';
        this.canvas.style.bottom = 0;
        this.canvas.style.left = 0;
        this.canvas.style.zIndex = 3;
        document.body.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        window.addEventListener('resize', this.resize.bind(this), false);
        this.resize();
    }

    resize() {
        this.canvas.width = window.innerWidth;
    }

    draw() {

        let borderHeight = 10;

        // draw background
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.beginPath();
        this.ctx.rect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.fillStyle = '#000000';
        this.ctx.fill();
        this.ctx.strokeStyle = '#a1a1a1';
        this.ctx.stroke();

        // draw spectrum
        this.ctx.beginPath();
        let spectrum = this.sound.getSpectrum();
        let spectrumValue = null;
        let spectrumLength = spectrum.length;
        let spectrumWidth = this.canvas.width / spectrumLength;
        let spectrumHeight = this.canvas.height - borderHeight;
        for (let i = 0; i < spectrumLength; i++) {

            spectrumValue = spectrum[i] / 256;
            this.ctx.rect(i * spectrumWidth, spectrumHeight - spectrumHeight * spectrumValue, spectrumWidth / 2, spectrumHeight * spectrumValue);
        }
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fill();

        // draw frequency
        this.ctx.beginPath();
        this.ctx.font = "10px Arial";
        this.ctx.textBaseline = 'middle';
        this.ctx.textAlign = "left";
        for (let i = 0, len = spectrumLength; i < len; i++) {

            if (i % 10 == 0) {
                this.ctx.rect(i * spectrumWidth, spectrumHeight, spectrumWidth / 2, borderHeight);
                this.ctx.fillText(i, i * spectrumWidth + 4, spectrumHeight + borderHeight * .5);
            }
        }
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fill();

        // draw kick
        let kicks = this.sound._kicks;
        let kick = null;
        let kickLength = kicks.length;
        let kickFrequencyStart = null;
        let kickFrequencyLength = null;
        for (let i = 0, len = kickLength; i < len; i++) {

            kick = kicks[i];
            if (kick.isOn) {
                kickFrequencyStart = (kick.frequency.length ? kick.frequency[0] : kick.frequency);
                kickFrequencyLength = (kick.frequency.length ? kick.frequency[1] - kick.frequency[0] + 1 : 1);
                this.ctx.beginPath();
                this.ctx.rect(kickFrequencyStart * spectrumWidth, spectrumHeight - spectrumHeight * (kick.threshold / 256), kickFrequencyLength * spectrumWidth - (spectrumWidth * .5), 2);
                this.ctx.rect(kickFrequencyStart * spectrumWidth, spectrumHeight - spectrumHeight * (kick.currentThreshold / 256), kickFrequencyLength * spectrumWidth - (spectrumWidth * .5), 5);
                this.ctx.fillStyle = kick.isKick ? '#00ff00' : '#ff0000';
                this.ctx.fill();
            }
        }

        // draw waveform
        this.ctx.beginPath();
        let waveform = this.sound.getWaveform();
        let waveformValue = null;
        let waveformLength = waveform.length;
        let waveformWidth = this.canvas.width / waveformLength;
        let waveformHeight = this.canvas.height - borderHeight;
        for (let i = 0; i < waveformLength; i++) {

            waveformValue = waveform[i] / 256;
            if (i == 0) this.ctx.moveTo(i * waveformWidth, waveformHeight * waveformValue);
            else this.ctx.lineTo(i * waveformWidth, waveformHeight * waveformValue);
        }
        this.ctx.strokeStyle = '#0000ff';
        this.ctx.stroke();

        // draw time
        this.ctx.beginPath();
        this.ctx.textAlign = "right";
        this.ctx.textBaseline = 'top';
        this.ctx.font = "15px Arial";
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillText((Math.round(this.sound.time * 10) / 10) + ' / ' + (Math.round(this.sound.duration * 10) / 10), this.canvas.width - 5, 5);

        // draw section
        this.ctx.beginPath();
        let sections = this.sound._sections;
        let section = null;
        let sectionLength = sections.length;
        let sectionLabels = '';
        for (let i = 0, len = sectionLength; i < len; i++) {

            section = sections[i];
            if (section.condition()) {
                sectionLabels += section.label + ' - ';
            }
        }
        if (sectionLabels.length > 0) sectionLabels = sectionLabels.substr(0, sectionLabels.length - 3);
        this.ctx.fillText(sectionLabels, this.canvas.width - 5, 25);
        this.ctx.fill();
    }
}

///////////////////// APP ////////////////////

var tick = 0;
var isKick = 0;
var src = 'https://res.cloudinary.com/dn32la6ny/video/upload/v1543921743/Worakls-Bleu.mp3';
var sound = new Sound(src, 100, 1, () => { sound.play() }, false);
var firstKicks;
var secondtKicks;
var thirdKicks;
var fourthKicks;
var fifthKicks;
var sixthKicks;
var seventhKicks;
var container;
var scene;
var camera;
var renderer;
var controls;
var geometry;
var material;
var points;

document.getElementById('start').addEventListener("click", start);

function app() {

    firstKicks = sound.createKick({
        frequency: [3, 10],
        threshold: 230,
        decay: 5.0,
        onKick: (kick) => {
            isKick = kick
        }, offKick: null
    });
    firstKicks.on();

    secondtKicks = sound.createKick({
        frequency: [65, 90],
        threshold: 40,
        decay: 10.9,
        onKick: (kick) => {
            isKick = kick
        }, offKick: null
    });

    thirdKicks = sound.createKick({
        frequency: [120, 130],
        threshold: 20,
        decay: 10.9,
        onKick: (kick) => {
            isKick = kick
        }, offKick: null
    });

    fourthKicks = sound.createKick({
        frequency: [160, 190],
        threshold: 40,
        decay: 10.9,
        onKick: (kick) => {
            isKick = kick
        }, offKick: null
    });

    fifthKicks = sound.createKick({
        frequency: [70, 180],
        threshold: 10,
        decay: 10.9,
        onKick: (kick) => {
            isKick = kick
        }, offKick: null
    });

    sixthKicks = sound.createKick({
        frequency: [70, 180],
        threshold: 60,
        decay: 10.9,
        onKick: (kick) => {
            isKick = kick
        }, offKick: null
    });

    seventhKicks = sound.createKick({
        frequency: [160, 190],
        threshold: 10,
        decay: 10.9,
        onKick: (kick) => {
            isKick = kick
        }, offKick: null
    });

    sound.onceAt('firstChangeKick', 45, () => {
        firstKicks.off()
        secondtKicks.on()
        thirdKicks.off()
        fourthKicks.off()
        fifthKicks.off()
        this.sixthKicks.off()
        seventhKicks.off()
    })

    sound.onceAt('secondChangeKick', 61, () => {
        firstKicks.off()
        secondtKicks.off()
        thirdKicks.on()
        fourthKicks.off()
        fifthKicks.off()
        sixthKicks.off()
        seventhKicks.off()
    })

    sound.onceAt('thirdChangeKick', 63, () => {
        firstKicks.off()
        secondtKicks.off()
        thirdKicks.off()
        fourthKicks.on()
        fifthKicks.off()
        sixthKicks.off()
        seventhKicks.on()
    })

    sound.onceAt('fourthChangeKick', 145.8, () => {
        firstKicks.off()
        secondtKicks.off()
        thirdKicks.off()
        fourthKicks.off()
        fifthKicks.on()
        sixthKicks.on()
        seventhKicks.off()
    })

    container = document.querySelector('#main');
    document.body.appendChild(container);

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10000);
    camera.position.z = 100;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x1c1c1f, 1);
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);

    geometry = new THREE.BoxBufferGeometry(40, 40, 40, 80, 80, 80);

    let uniforms = {
        soundKick: {
            type: "f",
            value: 0.0
        }
    };

    material = new THREE.ShaderMaterial({
        vertexShader: document.getElementById("vert-shader").textContent,
        fragmentShader: document.getElementById("frag-shader").textContent,
        uniforms: uniforms
    });

    points = new THREE.Points(this.geometry, this.material);
    points.rotation.y = 0.25 * Math.PI;
    points.rotation.x = 0.15 * Math.PI;

    scene.add(points);

    window.addEventListener('resize', onWindowResize.bind(this), false);
    onWindowResize();

    renderer.setAnimationLoop(render.bind(this));
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function render() {
    tick++;
    points.rotation.y += 0.0025;
    material.uniforms.soundKick.value = this.isKick * 0.005
    renderer.render(scene, camera);
}

if (sound.ctx.state === 'suspended' && 'ontouchstart' in window) {
    var unlock = function () {
        sound.ctx.resume().then(function () {
            document.body.removeEventListener('touchstart', unlock);
            document.body.removeEventListener('touchend', unlock);
            document.getElementById("home").style.display = "none"
            document.getElementById("app").style.display = "contents"
            document.getElementById("main").style.display = "contents"
            app()
        });
    };
    document.body.addEventListener('touchstart', unlock, false);
    document.body.addEventListener('touchend', unlock, false);
}

function start() {
    document.getElementById("home").style.display = "none";
    document.getElementById("app").style.display = "initial";
    document.getElementById("main").style.display = "initial";
    app()
}