#!/bin/bash

# =========================
# POOL SESSIONS DEPLOY SCRIPT
# =========================

MESSAGE=$1

if [ -z "$MESSAGE" ]
then
  echo "❌ Debes escribir un mensaje de commit"
  echo "Ejemplo: ./deploy.sh 'fix confirmacion page'"
  exit 1
fi

echo "🚀 Agregando cambios..."
git add .

echo "📝 Haciendo commit..."
git commit -m "$MESSAGE"

echo "⬆️ Subiendo a GitHub..."
git push origin main

echo "✅ Deploy enviado correctamente"