const presets = [
  [
    '@babel/preset-env',
    {
      targets: { electron: 16 }
    }
  ],
  ['@babel/preset-react']
];

module.exports = { presets };
