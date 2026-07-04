import cv2
import torch
import numpy as np
from facenet_pytorch import MTCNN, InceptionResnetV1

device = 'cuda' if torch.cuda.is_available() else 'cpu'

mtcnn = MTCNN(keep_all=True, device=device)
resnet = InceptionResnetV1(pretrained='vggface2').eval().to(device)

face_db = {}

def register_face(name, frame):
    img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    faces = mtcnn(img)
    if faces is not None:
        embedding = resnet(faces.to(device)).detach().cpu().numpy()
        face_db[name] = embedding[0]

def recognize_face(frame):
    img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    faces = mtcnn(img)
    if faces is not None:
        embeddings = resnet(faces.to(device)).detach().cpu().numpy()
        for emb in embeddings:
            for name, db_emb in face_db.items():
                dist = np.linalg.norm(emb - db_emb)
                if dist < 1.0:
                    return name
    return "Unknown"

cap = cv2.VideoCapture(0)

while True:
    ret, frame = cap.read()
    if not ret:
        break

    name = recognize_face(frame)

    cv2.putText(frame, name, (30, 50),
                cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)

    cv2.imshow("Face Attendance System", frame)

    key = cv2.waitKey(1)

    if key == ord('r'):
        user_name = input()
        register_face(user_name, frame)

    elif key == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
