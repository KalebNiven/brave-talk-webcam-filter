const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

const root = path.resolve(__dirname);
const dist = path.resolve(__dirname, 'dist');

module.exports = {
  devtool: false,
  entry: {
    content:        './src/content/content.js',
    injected:       './src/content/injected.js',
    popup:          './src/popup/popup.js',
    service_worker: './src/background/service_worker.js',
  },
  output: {
    filename: '[name].bundle.js',
    path: dist,
    clean: true,
  },
  module: {
    rules: [],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: dist },
        { from: 'src/popup/popup.html', to: path.join(dist, 'popup.html') },
        { from: 'src/popup/popup.css', to: path.join(dist, 'popup.css') },
        { from: 'icons', to: path.join(dist, 'icons') },
        {
          // Only copy the SIMD variants — Brave/Chrome ship with SIMD support.
          // Dropping the nosimd fallback saves ~10 MB from the extension.
          from: 'node_modules/@mediapipe/tasks-vision/wasm',
          to: path.join(dist, 'lib', 'mediapipe', 'wasm'),
          filter: (resourcePath) => !resourcePath.includes('nosimd'),
        },
      ],
    }),
  ],
  resolve: {
    extensions: ['.js'],
  },
  performance: {
    // WASM files are inherently large — suppress the false-positive size warning.
    hints: false,
  },
};
