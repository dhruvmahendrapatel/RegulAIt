terraform {
  # write-only arguments (administrator_password_wo) need 1.11 or later
  required_version = ">= 1.11.1"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.40, < 6.0"
    }
  }
}
