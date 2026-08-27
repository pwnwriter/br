vim.pack.add({
  { src = "https://github.com/neovim/nvim-lspconfig", name = "lspconfig" }
})

vim.lsp.enable({
  "ts_ls", -- typescript
  "zls",   -- astro
})

return {}
