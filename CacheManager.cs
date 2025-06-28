using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Linq;
using Spectre.Console;

namespace KeyVaultTool
{
    public class CacheManager
    {
        private readonly string _cacheFilePath;
        private readonly string _saltFilePath;
        private readonly string _ivFilePath;
        private Dictionary<string, VaultCache> _cache;
        private readonly object _cacheLock = new object();
        private string? _password;
        private byte[]? _salt;
        private byte[]? _iv;

        public CacheManager()
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var cacheDir = Path.Combine(appDataPath, "KeyVaultTool");
            Directory.CreateDirectory(cacheDir);
            _cacheFilePath = Path.Combine(cacheDir, "cache.dat");
            _saltFilePath = Path.Combine(cacheDir, "cache.salt");
            _ivFilePath = Path.Combine(cacheDir, "cache.iv");
            _cache = new Dictionary<string, VaultCache>();
        }

        public void PromptForPassword()
        {
            _password = AnsiConsole.Prompt(
                new TextPrompt<string>("Enter cache password:")
                    .PromptStyle("red")
                    .Secret()
            );
        }

        public async Task LoadCacheAsync()
        {
            if (!File.Exists(_cacheFilePath) || !File.Exists(_saltFilePath) || !File.Exists(_ivFilePath))
            {
                _cache = new Dictionary<string, VaultCache>();
                return;
            }

            _salt = await File.ReadAllBytesAsync(_saltFilePath);
            _iv = await File.ReadAllBytesAsync(_ivFilePath);

            if (_password == null)
                PromptForPassword();

            try
            {
                var encryptedData = await File.ReadAllBytesAsync(_cacheFilePath);
                var decryptedData = AesEncryptionHelper.Decrypt(encryptedData, _password!, _salt!, _iv!);
                var json = Encoding.UTF8.GetString(decryptedData);
                _cache = JsonSerializer.Deserialize<Dictionary<string, VaultCache>>(json) ?? new Dictionary<string, VaultCache>();
            }
            catch
            {
                // Cache file doesn't exist or is corrupted, start fresh
                _cache = new Dictionary<string, VaultCache>();
            }
        }

        public async Task SaveCacheAsync()
        {
            if (_password == null)
                PromptForPassword();

            if (_salt == null)
            {
                _salt = AesEncryptionHelper.GenerateSalt();
                await File.WriteAllBytesAsync(_saltFilePath, _salt);
            }

            try
            {
                var json = JsonSerializer.Serialize(_cache);
                var data = Encoding.UTF8.GetBytes(json);
                var encryptedData = AesEncryptionHelper.Encrypt(data, _password!, _salt!, out var iv);
                await File.WriteAllBytesAsync(_cacheFilePath, encryptedData);
                await File.WriteAllBytesAsync(_ivFilePath, iv);
            }
            catch (Exception ex)
            {
                AnsiConsole.MarkupLine($"[red]Failed to save encrypted cache: {ex.Message}[/]");
            }
        }

        public void UpdateVaultCache(string vaultUrl, VaultCache vaultCache)
        {
            lock (_cacheLock)
            {
                _cache[vaultUrl] = vaultCache;
            }
        }

        public List<CachedResource> GlobalSearch(string searchTerm)
        {
            var results = new List<CachedResource>();
            
            lock (_cacheLock)
            {
                foreach (var vault in _cache)
                {
                    // Search secrets
                    foreach (var secret in vault.Value.Secrets)
                    {
                        if (secret.Name.Contains(searchTerm, StringComparison.OrdinalIgnoreCase))
                        {
                            results.Add(new CachedResource
                            {
                                VaultUrl = vault.Key,
                                ResourceType = "secret",
                                Name = secret.Name,
                                Created = secret.Created,
                                Enabled = secret.Enabled,
                                ExpiresOn = secret.ExpiresOn
                            });
                        }
                    }

                    // Search keys
                    foreach (var key in vault.Value.Keys)
                    {
                        if (key.Name.Contains(searchTerm, StringComparison.OrdinalIgnoreCase))
                        {
                            results.Add(new CachedResource
                            {
                                VaultUrl = vault.Key,
                                ResourceType = "key",
                                Name = key.Name,
                                Created = key.Created,
                                Enabled = key.Enabled,
                                ExpiresOn = key.ExpiresOn
                            });
                        }
                    }

                    // Search certificates
                    foreach (var cert in vault.Value.Certificates)
                    {
                        if (cert.Name.Contains(searchTerm, StringComparison.OrdinalIgnoreCase))
                        {
                            results.Add(new CachedResource
                            {
                                VaultUrl = vault.Key,
                                ResourceType = "certificate",
                                Name = cert.Name,
                                Created = cert.Created,
                                Enabled = cert.Enabled,
                                ExpiresOn = cert.ExpiresOn
                            });
                        }
                    }
                }
            }

            return results;
        }

        public List<CachedResource> GetExpiringCertificates(int daysThreshold = 30)
        {
            var results = new List<CachedResource>();
            var threshold = DateTime.UtcNow.AddDays(daysThreshold);
            
            lock (_cacheLock)
            {
                foreach (var vault in _cache)
                {
                    foreach (var cert in vault.Value.Certificates)
                    {
                        if (cert.ExpiresOn.HasValue && cert.ExpiresOn.Value <= threshold && cert.Enabled)
                        {
                            results.Add(new CachedResource
                            {
                                VaultUrl = vault.Key,
                                ResourceType = "certificate",
                                Name = cert.Name,
                                Created = cert.Created,
                                Enabled = cert.Enabled,
                                ExpiresOn = cert.ExpiresOn
                            });
                        }
                    }
                }
            }

            return results.OrderBy(r => r.ExpiresOn).ToList();
        }

        public void ClearCache()
        {
            lock (_cacheLock)
            {
                _cache.Clear();
            }
            
            if (File.Exists(_cacheFilePath))
            {
                File.Delete(_cacheFilePath);
            }
            if (File.Exists(_saltFilePath))
            {
                File.Delete(_saltFilePath);
            }
            if (File.Exists(_ivFilePath))
            {
                File.Delete(_ivFilePath);
            }
        }

        public int GetCacheSize()
        {
            lock (_cacheLock)
            {
                return _cache.Count;
            }
        }
    }

    public class VaultCache
    {
        public string VaultUrl { get; set; } = "";
        public List<CachedSecret> Secrets { get; set; } = new List<CachedSecret>();
        public List<CachedKey> Keys { get; set; } = new List<CachedKey>();
        public List<CachedCertificate> Certificates { get; set; } = new List<CachedCertificate>();
        public DateTime LastUpdated { get; set; } = DateTime.UtcNow;
    }

    public class CachedSecret
    {
        public string Name { get; set; } = "";
        public DateTime? Created { get; set; }
        public DateTime? ExpiresOn { get; set; }
        public bool Enabled { get; set; }
        public Dictionary<string, string> Tags { get; set; } = new Dictionary<string, string>();
    }

    public class CachedKey
    {
        public string Name { get; set; } = "";
        public string KeyType { get; set; } = "";
        public DateTime? Created { get; set; }
        public DateTime? ExpiresOn { get; set; }
        public bool Enabled { get; set; }
        public Dictionary<string, string> Tags { get; set; } = new Dictionary<string, string>();
    }

    public class CachedCertificate
    {
        public string Name { get; set; } = "";
        public string Subject { get; set; } = "";
        public string Issuer { get; set; } = "";
        public DateTime? Created { get; set; }
        public DateTime? ExpiresOn { get; set; }
        public bool Enabled { get; set; }
        public Dictionary<string, string> Tags { get; set; } = new Dictionary<string, string>();
    }

    public class CachedResource
    {
        public string VaultUrl { get; set; } = "";
        public string ResourceType { get; set; } = "";
        public string Name { get; set; } = "";
        public DateTime? Created { get; set; }
        public DateTime? ExpiresOn { get; set; }
        public bool Enabled { get; set; }
        public Dictionary<string, string> Tags { get; set; } = new Dictionary<string, string>();

        public string GetExpirationStatus()
        {
            if (!ExpiresOn.HasValue) return "🟢 No expiration";
            
            var daysUntilExpiry = (ExpiresOn.Value - DateTime.UtcNow).TotalDays;
            
            if (daysUntilExpiry < 0) return "🔴 Expired";
            if (daysUntilExpiry <= 30) return "🔴 Critical";
            if (daysUntilExpiry <= 60) return "🟡 Warning";
            return "🟢 Safe";
        }
    }
} 